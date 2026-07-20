import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Request, Response } from 'express';
import type { IncomingMessage } from 'http';
import WebSocket, { type RawData } from 'ws';
import { config } from '../config';
import { getOrCreateLead } from '../crm/adapter';
import pool from '../db';
import { logger } from '../utils/logger';
import {
  createConfiguredVoiceRuntime,
  type VoiceAgentConfiguration,
} from '../voice/configured-runtime';
import { BoundedCallRecording } from '../voice/recording';
import type {
  VoiceRuntime,
  VoiceRuntimeEvent,
} from '../voice/runtime';
import {
  createBoundedVoiceWebSocketSender,
  deliverFinalTranscript,
  ProvisionalVoiceSessionRegistry,
  SerializedStartupFrameRouter,
  VoiceEventGenerationGate,
  VoiceSessionDrainTracker,
  voiceChannelFrameByteLength,
  type VoiceChannelFrame,
} from '../voice/telephony/voice-channel-helpers';
import {
  VoximplantMediaTransport,
  VoximplantProtocolError,
} from '../voice/telephony/voximplant-media';
import {
  authorizeVoiceWebSocketRequest,
  isVoiceTokenValid,
  type VoiceWebSocketIdentity,
} from '../voice/telephony/voice-ws-auth';

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

interface VoiceSession {
  bridge?: VoiceRuntime;
  transport: VoximplantMediaTransport;
  orgId: string;
  conversationId: string;
  leadId: string;
  phone: string;
  recording: BoundedCallRecording;
  transcript: string[];
  startTime: Date;
}

type AgentRow = Readonly<{
  id: string;
  system_prompt: string;
  voice_config: unknown;
}>;

const sessionRegistry = new ProvisionalVoiceSessionRegistry<VoiceSession>();
const sessionDrainTracker = new VoiceSessionDrainTracker();

export const DEFAULT_VOICE_SESSION_SHUTDOWN_TIMEOUT_MS = 15_000;

export type VoiceSessionShutdownResult = Readonly<{
  drained: boolean;
  pendingWork: number;
  activeSessions: number;
  initializingSessions: number;
}>;

/**
 * Stop admitting voice sessions, cancel any in-progress initialization, and
 * wait for runtime disconnect plus recording/conversation persistence.
 */
export async function shutdownVoiceSessions(
  options: Readonly<{ timeoutMs?: number }> = {}
): Promise<VoiceSessionShutdownResult> {
  const sessionIds = sessionRegistry.beginShutdown();
  for (const sessionId of sessionIds) {
    void endVoiceSession(sessionId).catch(error => {
      logger.error('Failed to finalize voice session during shutdown', {
        error,
        sessionId,
      });
    });
  }

  const drain = await sessionDrainTracker.drain(
    options.timeoutMs ?? DEFAULT_VOICE_SESSION_SHUTDOWN_TIMEOUT_MS
  );
  const activeSessions = sessionRegistry.activeCount;
  const initializingSessions = sessionRegistry.initializingCount;
  return {
    drained:
      drain.drained &&
      activeSessions === 0 &&
      initializingSessions === 0,
    pendingWork: drain.pendingCount,
    activeSessions,
    initializingSessions,
  };
}

/**
 * Optional Voximplant lifecycle webhook. Mutating events require the same
 * shared secret as the media WebSocket.
 */
export async function handleVoximplantWebhook(
  req: Request,
  res: Response
): Promise<void> {
  const { event, call_id: callId, caller_id: callerId } = req.body as {
    event?: string;
    call_id?: string;
    caller_id?: string;
  };

  if (
    !isVoiceTokenValid(
      req.get('x-voice-token'),
      config.VOICE_WS_AUTH_TOKEN
    )
  ) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (event === 'incoming_call') {
    logger.info('Voice call started', { callId, callerId });
    res.json({ ok: true, session_id: callId });
    return;
  }

  if (event === 'call_ended' && callId) {
    await endVoiceSession(callId);
  }

  res.json({ ok: true });
}

/**
 * Authenticated full-duplex Voximplant media endpoint.
 */
export async function handleVoiceWebSocket(
  ws: WebSocket,
  req: IncomingMessage
): Promise<void> {
  const authorization = authorizeVoiceWebSocketRequest(
    req,
    config.VOICE_DEFAULT_ORG_ID,
    config.VOICE_WS_AUTH_TOKEN
  );
  if (!authorization.ok) {
    logger.warn('Rejected voice WebSocket', {
      reason: authorization.code,
      remoteAddress: req.socket.remoteAddress,
    });
    ws.close(1008, 'Unauthorized voice connection');
    return;
  }

  const identity = authorization.identity;
  if (!sessionRegistry.tryReserve(identity.sessionId)) {
    ws.close(
      sessionRegistry.isAccepting ? 1008 : 1012,
      sessionRegistry.isAccepting
        ? 'Duplicate voice session'
        : 'Voice service shutting down'
    );
    return;
  }

  let resolveInitializationDone!: () => void;
  const initializationDone = new Promise<void>(resolve => {
    resolveInitializationDone = resolve;
  });
  void sessionDrainTracker.track(initializationDone);
  const handleInboundFailure = (error: unknown): void => {
    handleProtocolFailure(ws, identity, error);
  };
  const frameRouter = new SerializedStartupFrameRouter<VoiceChannelFrame>({
    maxQueuedBytes: config.VOICE_WS_MAX_PAYLOAD_BYTES * 4,
    byteLength: voiceChannelFrameByteLength,
    onFailure: handleInboundFailure,
  });

  ws.on('message', (data, isBinary) => {
    frameRouter.enqueue(normalizeRawFrame(data, isBinary));
  });
  ws.once('close', () => {
    logger.info('Voice WebSocket closed', {
      sessionId: identity.sessionId,
    });
    void initializationDone
      .then(() => frameRouter.idle())
      .then(() => endVoiceSession(identity.sessionId))
      .catch(error => {
        logger.error('Failed to close voice session', {
          error,
          sessionId: identity.sessionId,
        });
      });
  });
  ws.on('error', error => {
    logger.error('Voice WebSocket error', {
      error: error.message,
      sessionId: identity.sessionId,
    });
  });

  try {
    await initializeVoiceSession(
      ws,
      identity,
      handler => frameRouter.activate(handler)
    );
  } catch (error) {
    logger.error('Voice session initialization failed', {
      error,
      sessionId: identity.sessionId,
    });
    await endVoiceSession(identity.sessionId);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Voice service unavailable');
    }
  } finally {
    sessionRegistry.finishInitialization(identity.sessionId);
    resolveInitializationDone();
  }
}

async function initializeVoiceSession(
  ws: WebSocket,
  identity: VoiceWebSocketIdentity,
  activateFrameHandler: (
    handler: (frame: VoiceChannelFrame) => Promise<void>
  ) => Promise<void>
): Promise<void> {
  logger.info('Voice WebSocket authenticated', {
    sessionId: identity.sessionId,
    phone: identity.phone,
    orgId: identity.orgId,
    runtime: config.VOICE_RUNTIME,
  });

  const { id: leadId } = await getOrCreateLead(
    identity.orgId,
    identity.phone,
    'voice'
  );
  const agentResult = await pool.query<AgentRow>(
    `SELECT id, system_prompt, voice_config
       FROM agents
      WHERE org_id = $1
        AND is_active = true
        AND 'voice' = ANY(channels)
      ORDER BY updated_at DESC
      LIMIT 1`,
    [identity.orgId]
  );
  const agent = agentResult.rows[0];
  if (!agent) {
    throw new Error('No active voice agent found');
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  const sendTransportFrame = createBoundedVoiceWebSocketSender({
    socket: ws,
    openState: WebSocket.OPEN,
    maxBufferedBytes: config.VOICE_WS_MAX_BUFFERED_BYTES,
    onSendError: error => {
      logger.error('Voice WebSocket send failed', {
        error,
        sessionId: identity.sessionId,
      });
    },
  });
  const transport = new VoximplantMediaTransport({
    maxInboundPayloadBytes: config.VOICE_WS_MAX_PAYLOAD_BYTES,
    maxQueuedOutboundBytes: config.VOICE_WS_MAX_PAYLOAD_BYTES * 2,
    send: sendTransportFrame,
  });

  const convResult = await pool.query<{ id: string }>(
    `INSERT INTO conversations
       (org_id, lead_id, agent_id, channel, status)
     VALUES ($1, $2, $3, 'voice', 'active')
     RETURNING id`,
    [identity.orgId, leadId, agent.id]
  );
  const conversationId = convResult.rows[0]!.id;
  const transcript: string[] = [];
  const generationGate = new VoiceEventGenerationGate();
  const session: VoiceSession = {
    transport,
    orgId: identity.orgId,
    conversationId,
    leadId,
    phone: identity.phone,
    recording: new BoundedCallRecording(
      config.VOICE_RECORDING_MAX_BYTES
    ),
    transcript,
    startTime: new Date(),
  };
  // Register provisionally before any runtime construction/connection can
  // throw, so close/error cleanup always owns the inserted conversation.
  if (!sessionRegistry.register(identity.sessionId, session)) {
    await endVoiceSession(identity.sessionId);
    return;
  }

  const bridge = createConfiguredVoiceRuntime({
    callId: identity.sessionId,
    conversationId,
    agent: parseAgentConfiguration(
      agent.system_prompt,
      agent.voice_config
    ),
    context: {
      orgId: identity.orgId,
      leadId,
      conversationId,
      phone: identity.phone,
    },
    onEvent: async event => {
      if (!generationGate.accept(event)) return;
      try {
        await deliverRuntimeEvent(
          ws,
          transport,
          conversationId,
          transcript,
          event
        );
      } catch (error) {
        logger.error('Voice runtime event delivery failed', {
          error,
          eventType: event.type,
          sessionId: identity.sessionId,
          conversationId,
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, 'Voice transport delivery failed');
        }
        throw error;
      }
    },
  });
  session.bridge = bridge;

  let stopReceived = false;
  const processFrame = async (
    frame: VoiceChannelFrame
  ): Promise<void> => {
    const inbound = transport.accept(frame.data, frame.isBinary);
    if (inbound.type === 'audio') {
      const wasTruncated = session.recording.truncated;
      session.recording.append(inbound.data);
      if (!wasTruncated && session.recording.truncated) {
        logger.warn('Voice recording reached configured limit', {
          sessionId: identity.sessionId,
          maxBytes: config.VOICE_RECORDING_MAX_BYTES,
        });
      }
      session.bridge?.sendAudio(inbound.data);
      return;
    }
    if (inbound.type === 'stop') {
      stopReceived = true;
      await endVoiceSession(identity.sessionId);
      return;
    }
    if (inbound.type === 'start') {
      logger.debug('Voximplant media stream started', {
        sessionId: identity.sessionId,
      });
    }
    if (
      inbound.type === 'custom' &&
      inbound.name === 'playback_ended'
    ) {
      const generation = inbound.payload['generation'];
      session.bridge?.notifyPlaybackEnded?.(
        typeof generation === 'number' ? generation : undefined
      );
    }
  };
  await activateFrameHandler(processFrame);
  if (
    stopReceived ||
    ws.readyState !== WebSocket.OPEN ||
    sessionRegistry.get(identity.sessionId) !== session
  ) {
    await endVoiceSession(identity.sessionId);
    return;
  }

  await bridge.connect();
  if (
    ws.readyState !== WebSocket.OPEN ||
    sessionRegistry.get(identity.sessionId) !== session
  ) {
    await endVoiceSession(identity.sessionId);
  }
}

async function deliverRuntimeEvent(
  ws: WebSocket,
  transport: VoximplantMediaTransport,
  conversationId: string,
  transcript: string[],
  event: VoiceRuntimeEvent
): Promise<void> {
  if (event.type === 'audio') {
    transport.sendAudio(event.data, event.generation);
    return;
  }

  if (event.type === 'playback_clear') {
    transport.clearPlayback(event.generation, event.reason);
    return;
  }

  if (event.type === 'playback_flush') {
    transport.finishOutput();
    return;
  }

  if (event.type === 'fallback_speech') {
    transport.sendCustomEvent('fallback_speech', {
      text: event.text,
      reason: event.reason,
      generation: event.generation,
    });
    return;
  }

  if (event.type === 'transcript') {
    await deliverFinalTranscript({
      event,
      transcript,
      finishPlayback: () => transport.finishOutput(),
      persist: async (role, text) => {
        await pool.query(
          `INSERT INTO messages (conversation_id, role, content)
           VALUES ($1, $2, $3)`,
          [conversationId, role, text]
        );
      },
      onPersistenceError: (error, role) => {
        logger.error('Failed to persist voice transcript', {
          error,
          conversationId,
          role,
        });
      },
    });
    return;
  }

  if (event.type === 'tool_call') {
    logger.info('Voice runtime tool call', {
      conversationId,
      tool: event.name,
    });
    return;
  }

  if (event.type === 'error') {
    logger.warn('Voice runtime warning', {
      conversationId,
      error: event.error,
    });
    return;
  }

  if (event.type === 'metric') {
    logger.info('Voice runtime metric', {
      conversationId,
      metric: event.name,
      value: event.value,
      unit: event.unit,
      generation: event.generation,
    });
    return;
  }

  if (event.type === 'close' && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Voice runtime closed');
  }
}

function parseAgentConfiguration(
  systemPrompt: string,
  raw: unknown
): VoiceAgentConfiguration {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = {};
    }
  }
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    systemPrompt,
    voice:
      typeof record['voice'] === 'string'
        ? record['voice']
        : undefined,
    fishReferenceId:
      typeof record['fish_reference_id'] === 'string'
        ? record['fish_reference_id']
        : undefined,
    speed:
      typeof record['speed'] === 'number' &&
      record['speed'] >= 0.5 &&
      record['speed'] <= 2
        ? record['speed']
        : undefined,
    greeting:
      typeof record['greeting'] === 'string'
        ? record['greeting']
        : undefined,
  };
}

function normalizeRawFrame(
  data: RawData,
  isBinary: boolean
): VoiceChannelFrame {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? Buffer.from(data)
      : Buffer.from(data);
  return {
    data: isBinary ? buffer : buffer.toString('utf8'),
    isBinary,
  };
}

function handleProtocolFailure(
  ws: WebSocket,
  identity: VoiceWebSocketIdentity,
  error: unknown
): void {
  logger.warn('Rejected Voximplant media frame', {
    sessionId: identity.sessionId,
    code:
      error instanceof VoximplantProtocolError
        ? error.code
        : 'handler_error',
  });
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(1003, 'Invalid voice media frame');
  }
}

/**
 * Finish the voice runtime, upload the bounded recording, and close the DB
 * conversation. Concurrent stop/close/webhook/shutdown calls share the same
 * finalization promise even though the registry entry is taken immediately.
 */
function endVoiceSession(sessionId: string): Promise<void> {
  const finalizationKey = `finalize:${sessionId}`;
  const existing =
    sessionDrainTracker.getRunning<void>(finalizationKey);
  if (existing) return existing;

  const session = sessionRegistry.take(sessionId);
  if (!session) return Promise.resolve();

  return sessionDrainTracker.runOnce(
    finalizationKey,
    () => finalizeVoiceSession(sessionId, session)
  );
}

async function finalizeVoiceSession(
  sessionId: string,
  session: VoiceSession
): Promise<void> {
  try {
    await session.bridge?.disconnect();
  } catch (error) {
    logger.error('Failed to disconnect voice runtime', {
      error,
      sessionId,
    });
  }

  const duration = Math.max(
    0,
    Math.round((Date.now() - session.startTime.getTime()) / 1000)
  );
  const audioBuffer = session.recording.toBuffer();
  const transcript = session.transcript.join('\n');

  try {
    const s3Key =
      `recordings/${session.orgId}/${session.conversationId}/` +
      `${sessionId}.ulaw`;
    await s3.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET_RECORDINGS,
        Key: s3Key,
        Body: audioBuffer,
        ContentType: 'audio/basic',
        Metadata: {
          orgId: session.orgId,
          conversationId: session.conversationId,
          duration: String(duration),
          truncated: String(session.recording.truncated),
        },
      })
    );
    await pool.query(
      `INSERT INTO call_recordings
         (conversation_id, s3_key, duration_seconds, transcript,
          file_size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        session.conversationId,
        s3Key,
        duration,
        transcript,
        audioBuffer.length,
      ]
    );
  } catch (error) {
    logger.error('Failed to save voice recording', {
      error,
      sessionId,
    });
  }

  try {
    await pool.query(
      `UPDATE conversations
          SET status = 'completed',
              ended_at = NOW(),
              duration_seconds = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [duration, session.conversationId]
    );
  } catch (error) {
    logger.error('Failed to complete voice conversation', {
      error,
      sessionId,
      conversationId: session.conversationId,
    });
  }

  logger.info('Voice session ended', {
    sessionId,
    duration,
    recordingBytes: audioBuffer.length,
    recordingTruncated: session.recording.truncated,
    conversationId: session.conversationId,
  });
}
