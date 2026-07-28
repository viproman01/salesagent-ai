import crypto, { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import pool from '../db';
import { config } from '../config';
import { requestTtsStream, type TtsProvider } from '../ai/tts-provider';
import { detectAudioFormat, transcribeAudio } from '../ai/openrouter-stt';
import { requireAuth, type JwtPayload } from './auth';
import { logger } from '../utils/logger';
import { generateAgentTurn } from '../orchestrator/session-manager';
import { secretsMatch } from '../middleware/webhookAuth';
import {
  assessVoiceComplexity,
  buildFastVoiceContext,
  claimReadyVoiceBackgroundTask,
  completeVoiceBackgroundDelivery,
  dismissVoiceBackgroundTask,
  getVoiceBackgroundState,
  releaseVoiceBackgroundTask,
  scheduleVoiceDeepTask,
} from '../orchestrator/voice-dual-model';

interface SpeechJob {
  text: string;
  provider: TtsProvider;
  model: string;
  voiceId: string | undefined;
  speed: number;
  expiresAt: number;
}
interface Agent {
  id: string;
  org_id: string;
  system_prompt: string;
  model_text: string;
  voice_config: unknown;
  temperature: number;
  max_tokens: number;
  is_active: number | boolean;
}
interface VoiceSessionRow {
  id: string;
  org_id: string;
  user_id: string;
  agent_id: string;
  status: string;
  stt_model: string;
  llm_model: string;
  deep_llm_model: string;
  tts_provider: TtsProvider;
  tts_model: string;
  tts_voice_id: string | null;
  language: string;
  voice_config: unknown;
}

const speechJobs = new Map<string, SpeechJob>();

const voiceConfigSchema = z.object({
  version: z.number().optional(),
  provider: z.enum(['fish', 'cartesia']).optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  voiceId: z.string().optional(),
  speed: z.number().min(0.5).max(2).optional(),
  stt: z.object({
    provider: z.literal('openrouter').optional(),
    model: z.string().optional(),
    language: z.string().optional(),
  }).optional(),
  vad: z.object({
    silenceMs: z.number().optional(),
    maxUtteranceSeconds: z.number().optional(),
  }).optional(),
  orchestration: z.object({
    fastModel: z.string().optional(),
    deepModel: z.string().optional(),
    complexRouting: z.boolean().optional(),
  }).optional(),
}).passthrough();

const legacyInputSchema = z.object({
  agentId: z.string().uuid(),
  text: z.string().max(4000).default(''),
  isGreeting: z.boolean().default(false),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(4000),
  })).max(12).default([]),
  phone: z.string().max(30).optional(),
  sessionId: z.string().max(100).optional(),
});

const sessionCreateSchema = z.object({
  agentId: z.string().uuid(),
  overrides: z.object({
    modelRef: z.string().min(1).max(200).optional(),
    ttsProvider: z.enum(['fish', 'cartesia']).optional(),
    voiceId: z.string().min(1).max(255).optional(),
  }).optional(),
});

const utteranceMetadataSchema = z.object({
  clientUtteranceId: z.string().min(8).max(100),
  durationMs: z.coerce.number().int().min(100).max(config.VOICE_MAX_UTTERANCE_SECONDS * 1000),
});
const backgroundDeliverySchema = z.object({
  force: z.boolean().default(false),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.VOICE_MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
    fields: 4,
  },
});

function voiceSettings(raw: unknown): {
  ttsProvider: TtsProvider;
  ttsModel: string;
  voiceId: string | undefined;
  speed: number;
  sttModel: string;
  sttLanguage: string;
  fastModel: string;
  deepModel: string;
  complexRouting: boolean;
} {
  let valueToParse = raw;
  if (typeof raw === 'string') {
    try { valueToParse = JSON.parse(raw); } catch { valueToParse = {}; }
  }
  const parsed = voiceConfigSchema.safeParse(valueToParse);
  const value = parsed.success ? parsed.data : {};
  const ttsProvider = value.provider ?? (config.CARTESIA_API_KEY ? 'cartesia' : 'fish');
  return {
    ttsProvider,
    ttsModel: value.model
      ?? (ttsProvider === 'cartesia' ? config.CARTESIA_MODEL : config.FISH_AUDIO_MODEL),
    voiceId: value.voiceId
      ?? value.voice
      ?? (ttsProvider === 'cartesia'
        ? config.CARTESIA_DEFAULT_VOICE_ID
        : config.FISH_AUDIO_DEFAULT_VOICE_ID),
    speed: value.speed ?? 1,
    sttModel: value.stt?.model ?? config.OPENROUTER_STT_MODEL,
    sttLanguage: value.stt?.language ?? config.OPENROUTER_STT_LANGUAGE,
    fastModel: value.orchestration?.fastModel ?? config.VOICE_FAST_MODEL,
    deepModel: value.orchestration?.deepModel ?? config.VOICE_DEEP_MODEL,
    complexRouting: value.orchestration?.complexRouting ?? true,
  };
}

function cleanupAudio(): void {
  const now = Date.now();
  for (const [token, job] of speechJobs) {
    if (job.expiresAt <= now) speechJobs.delete(token);
  }
}

async function getAgent(agentId: string, orgId?: string): Promise<Agent | null> {
  const result = await pool.query<Agent>(
    `SELECT id, org_id, system_prompt, model_text, voice_config, temperature, max_tokens, is_active
     FROM agents WHERE id = $1${orgId ? ' AND org_id = $2' : ''}`,
    orgId ? [agentId, orgId] : [agentId]
  );
  const agent = result.rows[0];
  return agent && Boolean(agent.is_active) ? agent : null;
}

function queueAnswerSpeech(
  agent: Agent,
  text: string,
  voiceIdOverride?: string,
  providerOverride?: TtsProvider,
  modelOverride?: string
): {
  audioPath: string | null;
  latencyMs: number;
  fallbackToText: boolean;
  provider: TtsProvider;
  model: string;
} {
  const settings = voiceSettings(agent.voice_config);
  const started = Date.now();
  cleanupAudio();
  const token = crypto.randomBytes(32).toString('hex');
  speechJobs.set(token, {
    text,
    provider: providerOverride ?? settings.ttsProvider,
    model: modelOverride ?? settings.ttsModel,
    voiceId: voiceIdOverride ?? settings.voiceId,
    speed: settings.speed,
    expiresAt: Date.now() + config.VOICE_AUDIO_TTL_SECONDS * 1000,
  });
  return {
    audioPath: `/api/voice/audio/${token}`,
    latencyMs: Date.now() - started,
    fallbackToText: false,
    provider: providerOverride ?? settings.ttsProvider,
    model: modelOverride ?? settings.ttsModel,
  };
}

async function answerLegacy(
  agent: Agent,
  input: z.infer<typeof legacyInputSchema>
): Promise<{ text: string; audioPath: string | null }> {
  const userText = input.isGreeting
    ? 'Клиент начал голосовой разговор. Кратко поздоровайся и предложи помощь.'
    : input.text;
  const turn = await generateAgentTurn({
    orgId: agent.org_id,
    agentId: agent.id,
    channel: 'voice',
    phone: input.phone ?? `voice-test-${input.sessionId ?? agent.id}`,
    text: userText,
    externalId: input.sessionId,
  });
  const text = turn.text || 'Чем могу помочь?';
  const speech = queueAnswerSpeech(agent, text);
  return { text, audioPath: speech.audioPath };
}

async function getVoiceSession(
  sessionId: string,
  orgId: string
): Promise<VoiceSessionRow | null> {
  const result = await pool.query<VoiceSessionRow>(
    `SELECT s.id, s.org_id, s.user_id, s.agent_id, s.status, s.stt_model,
            s.llm_model, s.deep_llm_model, s.tts_provider, s.tts_model,
            s.tts_voice_id, s.language, a.voice_config
     FROM voice_sessions s
     JOIN agents a ON a.id = s.agent_id
     WHERE s.id = $1 AND s.org_id = $2`,
    [sessionId, orgId]
  );
  return result.rows[0] ?? null;
}

export const voiceRouter = Router();

voiceRouter.post('/sessions', requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!config.OPENROUTER_API_KEY) {
    res.status(503).json({
      error: 'Голосовой тест недоступен: добавьте OPENROUTER_API_KEY для распознавания речи через Deepgram Nova-3.',
      code: 'OPENROUTER_STT_NOT_CONFIGURED',
    });
    return;
  }
  const parsed = sessionCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid voice session request', details: parsed.error.issues });
    return;
  }
  const user = (req as Request & { user: JwtPayload }).user;
  const agent = await getAgent(parsed.data.agentId, user.orgId);
  if (!agent) {
    res.status(404).json({ error: 'Active voice agent not found' });
    return;
  }
  const settings = voiceSettings(agent.voice_config);
  const sessionId = randomUUID();
  const llmModel = parsed.data.overrides?.modelRef ?? settings.fastModel;
  const deepModel = settings.deepModel;
  const ttsProvider = parsed.data.overrides?.ttsProvider ?? settings.ttsProvider;
  const ttsModel = ttsProvider === 'cartesia' ? config.CARTESIA_MODEL : config.FISH_AUDIO_MODEL;
  const voiceId = parsed.data.overrides?.voiceId ?? settings.voiceId;
  await pool.query(
    `INSERT INTO voice_sessions
       (id, org_id, user_id, agent_id, stt_model, llm_model, deep_llm_model,
        tts_provider, tts_model, tts_voice_id, language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      sessionId,
      user.orgId,
      user.userId,
      agent.id,
      settings.sttModel,
      llmModel,
      deepModel,
      ttsProvider,
      ttsModel,
      voiceId ?? null,
      settings.sttLanguage,
    ]
  );
  res.status(201).json({
    sessionId,
    state: 'active',
    effective: {
      stt: { provider: 'openrouter', model: settings.sttModel, language: settings.sttLanguage },
      llm: {
        model: llmModel,
        fastModel: llmModel,
        deepModel,
        mode: 'fast-with-background-deep',
      },
      tts: {
        provider: ttsProvider,
        model: ttsModel,
        voiceId: voiceId ?? null,
        speed: settings.speed,
        streaming: true,
      },
    },
    limits: {
      maxUtteranceSeconds: config.VOICE_MAX_UTTERANCE_SECONDS,
      maxUploadMb: config.VOICE_MAX_UPLOAD_MB,
    },
  });
});

voiceRouter.post(
  '/sessions/:id/utterances',
  requireAuth,
  upload.single('audio'),
  async (req: Request, res: Response): Promise<void> => {
    const user = (req as Request & { user: JwtPayload }).user;
    const metadata = utteranceMetadataSchema.safeParse(req.body);
    if (!metadata.success || !req.file) {
      res.status(400).json({
        error: !req.file ? 'Audio file is required' : 'Invalid utterance metadata',
        details: metadata.success ? undefined : metadata.error.issues,
      });
      return;
    }
    const sessionId = String(req.params['id'] ?? '');
    const session = await getVoiceSession(sessionId, user.orgId);
    if (!session || session.status !== 'active') {
      res.status(404).json({ error: 'Active voice session not found' });
      return;
    }
    const format = detectAudioFormat(req.file.mimetype, req.file.buffer);
    if (!format) {
      res.status(415).json({ error: 'Unsupported or invalid audio file' });
      return;
    }

    const utteranceId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO voice_utterances
           (id, session_id, client_utterance_id, audio_ms)
         VALUES ($1,$2,$3,$4)`,
        [utteranceId, session.id, metadata.data.clientUtteranceId, metadata.data.durationMs]
      );
    } catch (error) {
      const duplicate = error as { code?: string };
      if (duplicate.code !== 'ER_DUP_ENTRY') throw error;
      const existing = await pool.query<{ status: string; response_json: unknown }>(
        `SELECT status, response_json FROM voice_utterances
         WHERE session_id = $1 AND client_utterance_id = $2`,
        [session.id, metadata.data.clientUtteranceId]
      );
      if (existing.rows[0]?.status === 'completed' && existing.rows[0].response_json) {
        res.setHeader('X-Idempotent-Replay', 'true');
        res.json(existing.rows[0].response_json);
      } else {
        res.status(409).json({ error: 'Utterance is already being processed' });
      }
      return;
    }

    try {
      const stt = await transcribeAudio(
        req.file.buffer,
        format,
        session.language,
        session.stt_model
      );
      const agent = await getAgent(session.agent_id, user.orgId);
      if (!agent) throw new Error('Voice agent became unavailable');
      const settings = voiceSettings(agent.voice_config);
      const complexity = assessVoiceComplexity(stt.text);
      let background = await getVoiceBackgroundState(session.id);
      let backgroundTriggered = false;
      if (settings.complexRouting && complexity.complex) {
        const scheduled = await scheduleVoiceDeepTask({
          sessionId: session.id,
          sourceUtteranceId: utteranceId,
          question: stt.text,
          model: session.deep_llm_model,
        });
        background = scheduled.task;
        backgroundTriggered = scheduled.triggered;
      }
      const turn = await generateAgentTurn({
        orgId: user.orgId,
        agentId: agent.id,
        channel: 'voice',
        phone: `voice-session-${session.id}`,
        text: stt.text,
        externalId: session.id,
        modelOverride: session.llm_model,
        maxTokensOverride: config.VOICE_FAST_MAX_TOKENS,
        systemContext: buildFastVoiceContext({
          complexity,
          backgroundTask: background,
        }),
      });
      const text = turn.text || 'Чем могу помочь?';
      const speech = queueAnswerSpeech(
        agent,
        text,
        session.tts_voice_id ?? undefined,
        session.tts_provider,
        session.tts_model
      );
      const response = {
        sessionId: session.id,
        utteranceId: metadata.data.clientUtteranceId,
        transcript: stt.text,
        text,
        audioUrl: speech.audioPath,
        fallbackToText: speech.fallbackToText,
        effective: {
          stt: {
            provider: 'openrouter',
            model: stt.model,
            fallbackUsed: stt.fallbackUsed,
          },
          llm: {
            model: turn.llm.model,
            fastModel: session.llm_model,
            deepModel: session.deep_llm_model,
          },
          tts: {
            provider: speech.provider,
            model: speech.model,
            voiceId: session.tts_voice_id,
          },
        },
        background: {
          triggered: backgroundTriggered,
          taskId: background?.id ?? null,
          status: background?.status ?? 'idle',
          model: session.deep_llm_model,
          complexity,
        },
        latency: {
          sttMs: stt.latencyMs,
          llmMs: turn.llm.latencyMs,
          ttsMs: speech.latencyMs,
          totalMs: stt.latencyMs + turn.llm.latencyMs + speech.latencyMs,
        },
        usage: {
          audioSeconds: stt.usage.seconds || metadata.data.durationMs / 1000,
          sttCostUsd: stt.usage.cost,
          llmTokensInput: turn.llm.tokensInput,
          llmTokensOutput: turn.llm.tokensOutput,
        },
      };
      await pool.query(
        `UPDATE voice_utterances
         SET status = 'completed', transcript = $1, assistant_text = $2,
             response_json = $3, completed_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [stt.text, text, JSON.stringify(response), utteranceId]
      );
      await pool.query(
        `UPDATE voice_sessions
         SET utterance_count = utterance_count + 1,
             total_audio_ms = total_audio_ms + $1,
             total_cost_usd = total_cost_usd + $2,
             last_error = NULL
         WHERE id = $3`,
        [metadata.data.durationMs, stt.usage.cost, session.id]
      );
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Voice processing failed';
      await pool.query(
        `UPDATE voice_utterances SET status = 'failed', error_message = $1,
         completed_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [message, utteranceId]
      );
      await pool.query('UPDATE voice_sessions SET last_error = $1 WHERE id = $2', [message, session.id]);
      throw error;
    }
  }
);

voiceRouter.get(
  '/sessions/:id/background',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const user = (req as Request & { user: JwtPayload }).user;
    const sessionId = String(req.params['id'] ?? '');
    const session = await getVoiceSession(sessionId, user.orgId);
    if (!session || session.status !== 'active') {
      res.status(404).json({ error: 'Active voice session not found' });
      return;
    }
    const task = await getVoiceBackgroundState(session.id);
    res.json({
      status: task?.status ?? 'idle',
      taskId: task?.id ?? null,
      question: task?.question ?? null,
      model: task?.model ?? session.deep_llm_model,
      relevant: task?.relevant ?? true,
      laterTurns: task?.laterTurns ?? 0,
      completedAt: task?.completedAt ?? null,
      error: task?.status === 'failed' ? task.errorMessage : null,
    });
  }
);

voiceRouter.post(
  '/sessions/:id/background/:taskId/deliver',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const user = (req as Request & { user: JwtPayload }).user;
    const sessionId = String(req.params['id'] ?? '');
    const taskId = String(req.params['taskId'] ?? '');
    const delivery = backgroundDeliverySchema.safeParse(req.body);
    if (!delivery.success) {
      res.status(400).json({ error: 'Invalid background delivery request' });
      return;
    }
    const session = await getVoiceSession(sessionId, user.orgId);
    if (!session || session.status !== 'active') {
      res.status(404).json({ error: 'Active voice session not found' });
      return;
    }
    const task = await claimReadyVoiceBackgroundTask(
      session.id,
      taskId,
      delivery.data.force
    );
    if (!task?.answer) {
      res.status(409).json({
        error: 'Background answer is not ready, no longer current, or was already delivered',
        code: 'BACKGROUND_NOT_CURRENT',
      });
      return;
    }

    try {
      const agent = await getAgent(session.agent_id, user.orgId);
      if (!agent) throw new Error('Voice agent became unavailable');
      const text = task.answer.trim();
      const speech = queueAnswerSpeech(
        agent,
        text,
        session.tts_voice_id ?? undefined,
        session.tts_provider,
        session.tts_model
      );
      await completeVoiceBackgroundDelivery(task.id, text);
      res.json({
        taskId: task.id,
        question: task.question,
        text,
        audioUrl: speech.audioPath,
        fallbackToText: speech.fallbackToText,
        effective: {
          fastModel: session.llm_model,
          deepModel: task.model,
          ttsProvider: speech.provider,
          ttsModel: speech.model,
        },
      });
    } catch (error) {
      await releaseVoiceBackgroundTask(task.id, error);
      throw error;
    }
  }
);

voiceRouter.post(
  '/sessions/:id/background/:taskId/dismiss',
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const user = (req as Request & { user: JwtPayload }).user;
    const sessionId = String(req.params['id'] ?? '');
    const taskId = String(req.params['taskId'] ?? '');
    const session = await getVoiceSession(sessionId, user.orgId);
    if (!session || session.status !== 'active') {
      res.status(404).json({ error: 'Active voice session not found' });
      return;
    }
    const dismissed = await dismissVoiceBackgroundTask(session.id, taskId);
    if (!dismissed) {
      res.status(409).json({ error: 'Background answer can no longer be dismissed' });
      return;
    }
    res.status(204).end();
  }
);

voiceRouter.delete('/sessions/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = (req as Request & { user: JwtPayload }).user;
  const result = await pool.query(
    `UPDATE voice_sessions SET status = 'completed', ended_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND org_id = $2 AND status = 'active'`,
    [req.params['id'], user.orgId]
  );
  if (result.affectedRows === 0) {
    res.status(404).json({ error: 'Active voice session not found' });
    return;
  }
  res.status(204).end();
});

// Compatibility route used by the existing browser UI and Voximplant adapter.
voiceRouter.post('/respond', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const user = (req as Request & { user: JwtPayload }).user;
  const parsed = legacyInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid voice request', details: parsed.error.issues });
    return;
  }
  const agent = await getAgent(parsed.data.agentId, user.orgId);
  if (!agent) {
    res.status(404).json({ error: 'Active agent not found' });
    return;
  }
  const result = await answerLegacy(agent, parsed.data);
  res.json({
    text: result.text,
    audioUrl: result.audioPath,
    fallbackToText: result.audioPath === null,
  });
});

export const publicVoiceRouter = Router();

publicVoiceRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  if (config.NODE_ENV === 'production' && !req.secure && !config.ALLOW_INSECURE_VOICE_WEBHOOK) {
    res.status(426).json({ error: 'HTTPS is required for the public voice webhook' });
    return;
  }
  if (!secretsMatch(req.header('x-voice-secret'), config.VOICE_WEBHOOK_SECRET)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const parsed = legacyInputSchema.safeParse({
    ...req.body,
    agentId: req.body?.agent_id ?? req.body?.agentId,
    sessionId: req.body?.session_id ?? req.body?.sessionId,
  });
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid voice request' });
    return;
  }
  const agent = await getAgent(parsed.data.agentId);
  if (!agent) {
    res.status(404).json({ error: 'Active agent not found' });
    return;
  }
  const result = await answerLegacy(agent, parsed.data);
  const requestBaseUrl = `${req.protocol}://${req.get('host')}`;
  const audioUrl = result.audioPath ? `${requestBaseUrl}${result.audioPath}` : null;
  res.json({
    text: result.text,
    audio_url: audioUrl,
    fallback_to_text: audioUrl === null,
  });
});

publicVoiceRouter.get('/audio/:token', async (req: Request, res: Response): Promise<void> => {
  cleanupAudio();
  const token = req.params['token'];
  const normalized = Array.isArray(token) ? token[0] ?? '' : token ?? '';
  const job = speechJobs.get(normalized);
  if (!job) {
    res.status(404).end();
    return;
  }
  try {
    const tts = await requestTtsStream(
      job.provider,
      job.text,
      job.voiceId,
      job.speed,
      job.model
    );
    const upstream = tts.response;
    if (!upstream.body) throw new Error('TTS provider returned an empty stream');
    res.status(200);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/mpeg');
    res.setHeader('X-TTS-Provider', tts.provider);
    res.setHeader('X-TTS-Model', tts.model);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.flushHeaders();
    const stream = Readable.fromWeb(upstream.body as import('stream/web').ReadableStream);
    stream.on('error', error => {
      logger.error('TTS stream failed during playback', {
        error,
        token: normalized,
        provider: tts.provider,
      });
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error instanceof Error ? error : undefined);
    });
    stream.pipe(res);
  } catch (error) {
    logger.error('TTS streaming request failed', { error, token: normalized, provider: job.provider });
    if (!res.headersSent) res.status(502).json({ error: 'Voice synthesis failed' });
    else res.destroy(error instanceof Error ? error : undefined);
  }
});
