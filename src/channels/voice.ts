import type { Request, Response } from 'express';
import WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';
import { logger } from '../utils/logger';
import { GeminiLiveVoiceBridge } from '../ai/gemini-live';
import { getOrCreateLead } from '../crm/adapter';
import pool from '../db';

const s3 = new S3Client({
  endpoint:           config.S3_ENDPOINT,
  region:             config.S3_REGION,
  credentials: {
    accessKeyId:     config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

interface VoiceSession {
  bridge:         GeminiLiveVoiceBridge;
  orgId:          string;
  conversationId: string;
  leadId:         string;
  phone:          string;
  audioChunks:    Buffer[];
  transcript:     string[];
  startTime:      Date;
}

const activeSessions = new Map<string, VoiceSession>();

/**
 * Webhook от Voximplant — начало звонка
 * POST /api/webhooks/voximplant
 */
export async function handleVoximplantWebhook(req: Request, res: Response): Promise<void> {
  const { event, call_id, caller_id } = req.body as {
    event: string;
    call_id: string;
    caller_id: string;
  };

  if (event === 'incoming_call') {
    logger.info('Voice call started', { callId: call_id, callerId: caller_id });
    res.json({ ok: true, session_id: call_id });
    return;
  }

  if (event === 'call_ended') {
    await endVoiceSession(call_id);
  }

  res.json({ ok: true });
}

/**
 * WebSocket endpoint для аудиострима с Voximplant
 * WS /ws/voice/:sessionId
 */
export async function handleVoiceWebSocket(
  ws: WebSocket,
  req: IncomingMessage
): Promise<void> {
  const url    = new URL(req.url ?? '/', 'http://localhost');
  const parts  = url.pathname.split('/');
  const sessionId = parts[parts.length - 1] ?? 'unknown';
  const phone  = url.searchParams.get('phone') ?? '00000000000';
  const orgId  = url.searchParams.get('orgId') ?? '';

  logger.info('Voice WebSocket connected', { sessionId, phone, orgId });

  if (!orgId) {
    ws.close(1008, 'orgId required');
    return;
  }

  // Находим/создаём лид
  const { id: leadId } = await getOrCreateLead(orgId, phone, 'voice');

  // Создаём разговор в БД
  const agentResult = await pool.query<{ id: string; system_prompt: string }>(
    `SELECT id, system_prompt FROM agents
     WHERE org_id = $1 AND is_active = true AND 'voice' = ANY(channels)
     LIMIT 1`,
    [orgId]
  );
  const agent = agentResult.rows[0];
  if (!agent) {
    ws.close(1008, 'No active voice agent found');
    return;
  }

  const convResult = await pool.query<{ id: string }>(
    `INSERT INTO conversations (org_id, lead_id, agent_id, channel, status)
     VALUES ($1, $2, $3, 'voice', 'active')
     RETURNING id`,
    [orgId, leadId, agent.id]
  );
  const conversationId = convResult.rows[0]!.id;

  // Создаём Gemini Live мост
  const bridge = new GeminiLiveVoiceBridge(
    agent.system_prompt,
    { orgId, leadId, conversationId, phone },
    async (event) => {
      if (event.type === 'audio') {
        // Отправляем аудио обратно в Voximplant
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      } else if (event.type === 'transcript') {
        const session = activeSessions.get(sessionId);
        if (session && event.isFinal) {
          session.transcript.push(event.text);
          // Сохраняем транскрипт в БД
          await pool.query(
            `INSERT INTO messages (conversation_id, role, content)
             VALUES ($1, 'assistant', $2)`,
            [conversationId, event.text]
          );
        }
      } else if (event.type === 'close') {
        ws.close();
      }
    }
  );

  await bridge.connect();

  const session: VoiceSession = {
    bridge, orgId, conversationId, leadId, phone,
    audioChunks: [],
    transcript:  [],
    startTime:   new Date(),
  };
  activeSessions.set(sessionId, session);

  // Принимаем аудио от Voximplant (μ-law 8kHz)
  ws.on('message', (data: WebSocket.RawData) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    session.audioChunks.push(buf);
    bridge.sendAudio(buf);
  });

  ws.on('close', async () => {
    logger.info('Voice WebSocket closed', { sessionId });
    await endVoiceSession(sessionId);
  });

  ws.on('error', (err: Error) => {
    logger.error('Voice WebSocket error', { error: err.message, sessionId });
  });
}

/**
 * Завершить сессию голосового звонка: сохранить запись в S3
 */
async function endVoiceSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  activeSessions.delete(sessionId);
  session.bridge.disconnect();

  const duration = Math.round((Date.now() - session.startTime.getTime()) / 1000);
  const transcript = session.transcript.join('\n');

  // Объединяем все аудиочанки
  const audioBuffer = Buffer.concat(session.audioChunks);

  try {
    // Сохраняем запись в S3
    const s3Key = `recordings/${session.orgId}/${session.conversationId}/${sessionId}.ulaw`;
    await s3.send(new PutObjectCommand({
      Bucket:      config.S3_BUCKET_RECORDINGS,
      Key:         s3Key,
      Body:        audioBuffer,
      ContentType: 'audio/basic',
      Metadata: {
        orgId:          session.orgId,
        conversationId: session.conversationId,
        duration:       String(duration),
      },
    }));

    // Сохраняем метаданные записи в БД
    await pool.query(
      `INSERT INTO call_recordings (conversation_id, s3_key, duration_seconds, transcript, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.conversationId, s3Key, duration, transcript, audioBuffer.length]
    );
  } catch (err) {
    logger.error('Failed to save recording', { error: err, sessionId });
  }

  // Обновляем статус разговора
  await pool.query(
    `UPDATE conversations
     SET status = 'completed', ended_at = NOW(), duration_seconds = $1, updated_at = NOW()
     WHERE id = $2`,
    [duration, session.conversationId]
  );

  logger.info('Voice session ended', { sessionId, duration, conversationId: session.conversationId });
}
