import { Router } from 'express';
import { z } from 'zod';
import pool from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { requireAuth, type JwtPayload } from './auth';
import { searchKnowledge } from '../rag/search';
import {
  TextChatProviderError,
} from '../chat/cerebras-client';
import { WebChatService, WebChatServiceError } from '../chat/service';
import { generateAutomaticTextReply } from '../chat/provider-chain';

export const chatRouter = Router();

const requestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  sessionId: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const sessionIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

let service: WebChatService | undefined;

function getService(): WebChatService {
  if (!config.TEXT_CHAT_ENABLED) {
    throw new ChatDisabledError();
  }
  if (service) return service;

  service = new WebChatService({
    pool,
    historyMessages: config.TEXT_CHAT_HISTORY_MESSAGES,
    generateReply: generateAutomaticTextReply,
    searchKnowledge,
    onKnowledgeUnavailable: () => {
      logger.warn('Web chat knowledge context unavailable');
    },
  });
  return service;
}

function getHistoryService(): WebChatService {
  if (service) return service;
  service = new WebChatService({
    pool,
    historyMessages: config.TEXT_CHAT_HISTORY_MESSAGES,
    generateReply: generateAutomaticTextReply,
    searchKnowledge,
    onKnowledgeUnavailable: () => {
      logger.warn('Web chat knowledge context unavailable');
    },
  });
  return service;
}

chatRouter.get('/status', requireAuth, async (req, res, next): Promise<void> => {
  try {
    const user = (req as typeof req & { user: JwtPayload }).user;
    const agent = await pool.query<{ name: string }>(
      `SELECT name
       FROM agents
       WHERE org_id = $1 AND is_active = true AND 'webchat' = ANY(channels)
       ORDER BY created_at ASC
       LIMIT 1`,
      [user.orgId]
    );
    const agentName = agent.rows[0]?.name ?? null;
    res.json({
      enabled: config.TEXT_CHAT_ENABLED,
      ready: config.TEXT_CHAT_ENABLED && agentName !== null,
      agentName,
    });
  } catch (error) {
    next(error);
  }
});

chatRouter.get(
  '/:sessionId/history',
  requireAuth,
  async (req, res, next): Promise<void> => {
    const parsed = sessionIdSchema.safeParse(req.params['sessionId']);
    if (!parsed.success) {
      res.status(400).json({ error: 'Некорректная сессия' });
      return;
    }
    try {
      const user = (req as typeof req & { user: JwtPayload }).user;
      res.json(await getHistoryService().history({
        orgId: user.orgId,
        userId: user.userId,
        sessionId: parsed.data,
      }));
    } catch (error) {
      next(error);
    }
  }
);

chatRouter.post('/', requireAuth, async (req, res): Promise<void> => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректное сообщение' });
    return;
  }

  const user = (req as typeof req & { user: JwtPayload }).user;
  const controller = new AbortController();
  const abort = (): void => controller.abort('client-disconnected');
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });

  try {
    const result = await getService().reply({
      orgId: user.orgId,
      userId: user.userId,
      sessionId: parsed.data.sessionId,
      message: parsed.data.message,
      signal: controller.signal,
    });
    res.json(result);
  } catch (error) {
    const mapped = mapChatError(error);
    logger.warn('Web chat request failed', { code: mapped.code });
    res.status(mapped.status).json({ error: mapped.message });
  } finally {
    req.removeListener('aborted', abort);
  }
});

class ChatDisabledError extends Error {
  constructor() {
    super('Web chat disabled');
    this.name = 'ChatDisabledError';
  }
}

function mapChatError(error: unknown): Readonly<{
  status: number;
  code: string;
  message: string;
}> {
  if (error instanceof ChatDisabledError) {
    return {
      status: 503,
      code: 'disabled',
      message: 'Автоматический чат пока выключен',
    };
  }
  if (error instanceof WebChatServiceError) {
    return error.code === 'invalid_request'
      ? { status: 400, code: error.code, message: 'Некорректное сообщение' }
      : {
          status: 503,
          code: error.code,
          message: 'Нет активного агента для веб-чата',
        };
  }
  if (error instanceof TextChatProviderError) {
    return {
      status: error.code === 'timeout' ? 504 : 503,
      code: error.code,
      message:
        error.code === 'timeout'
          ? 'Ответ занял слишком много времени. Попробуйте ещё раз.'
          : 'Сервис ответа временно недоступен',
    };
  }
  return {
    status: 500,
    code: 'internal_failure',
    message: 'Не удалось обработать сообщение',
  };
}
