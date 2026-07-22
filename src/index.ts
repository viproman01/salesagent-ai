import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config';
import { logger } from './utils/logger';
import { testConnection } from './db';
import { authRouter } from './api/auth';
import { dashboardRouter } from './api/dashboard';
import { conversationsRouter } from './api/conversations';
import { knowledgeRouter } from './api/knowledge';
import { agentsRouter } from './api/agents';
import { recordingsRouter } from './api/recordings';
import { chatRouter } from './api/chat';
import { whatsappRouter } from './api/whatsapp';
import {
  initializeWhatsAppBridge,
  shutdownWhatsAppBridge,
} from './channels/whatsapp';
import {
  startWhatsAppOutboxWorker,
  stopWhatsAppOutboxWorker,
} from './whatsapp/outbox';
import { handleTelegramWebhook } from './channels/telegram';
import {
  handleVoximplantWebhook,
  handleVoiceWebSocket,
  shutdownVoiceSessions,
} from './channels/voice';
import { authorizeVoiceWebSocketRequest } from './voice/telephony/voice-ws-auth';
import { followUpWorker } from './orchestrator/follow-up';
import { metricsWorker } from './analytics/metrics';
import { globalErrorHandler } from './middleware/errorHandler';
import { apiLimit, chatLimit, webhookLimit } from './middleware/rateLimit';

async function main() {
  // Проверяем подключение к БД
  await testConnection();
  logger.info('Database connected');

  const app = express();

  // ---- Безопасность ----
  app.use(helmet());
  app.use(cors({
    origin:      config.FRONTEND_URL,
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
  app.use(compression());

  // ---- Rate limiting (granular per endpoint type) ----
  app.use('/api/v1/conversations', chatLimit);
  app.use('/api/v1/chat', chatLimit);
  app.use('/api/v1/', apiLimit);
  app.use('/api/webhooks', webhookLimit);

  // ---- Парсинг тела ----
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ---- Health check ----
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ---- REST API ----
  app.use('/api/v1/auth',           authRouter);
  app.use('/api/v1/dashboard',      dashboardRouter);
  app.use('/api/v1/conversations',  conversationsRouter);
  app.use('/api/v1/knowledge',      knowledgeRouter);
  app.use('/api/v1/agents',         agentsRouter);
  app.use('/api/v1/recordings',     recordingsRouter);
  app.use('/api/v1/chat',           chatRouter);
  app.use('/api/v1/whatsapp',       whatsappRouter);

  // ---- Webhooks ----
  app.post('/api/webhooks/telegram',   handleTelegramWebhook);
  app.post('/api/webhooks/voximplant', handleVoximplantWebhook);

  // OAuth is intentionally disabled until a one-time state store and a
  // server-side authorization-code exchange are implemented. Never echo an
  // OAuth code back to the browser or logs.
  app.get('/api/crm/amocrm/callback', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(404).json({ error: 'Not found' });
  });

  // ---- Обработка ошибок ----
  app.use(globalErrorHandler);

  // ---- HTTP + WebSocket сервер ----
  const httpServer = createServer(app);

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/voice',
    maxPayload: config.VOICE_WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    verifyClient: (info: { req: IncomingMessage }) =>
      authorizeVoiceWebSocketRequest(
        info.req,
        config.VOICE_DEFAULT_ORG_ID,
        config.VOICE_WS_AUTH_TOKEN
      ).ok,
  });
  wss.on('connection', (ws, req) => {
    handleVoiceWebSocket(ws, req).catch(err => {
      logger.error('Voice WebSocket handler error', { error: err });
      if (ws.readyState === ws.OPEN) {
        ws.close(1011, 'Voice handler failed');
      }
    });
  });

  // Запускаем BullMQ workers (отключаем при in-memory Redis)
  if (config.REDIS_URL !== 'memory') {
    logger.info('Starting background workers');
    followUpWorker.run().catch(err => logger.error('FollowUp worker error', { error: err }));
    metricsWorker.run().catch(err => logger.error('Metrics worker error', { error: err }));
  } else {
    logger.info('Background workers disabled (in-memory mode)');
  }

  // Запускаем сервер
  httpServer.listen(config.PORT, () => {
    logger.info(`SalesAgent AI started`, {
      port: config.PORT,
      env:  config.NODE_ENV,
    });
  });
  void initializeWhatsAppBridge().catch(error => {
    logger.error('WhatsApp session restore failed', { error });
  });
  startWhatsAppOutboxWorker();

  // Graceful shutdown
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.info(`Received ${signal}, shutting down gracefully`);

      const webSocketServerClosed = new Promise<void>(resolve => {
        wss.close(error => {
          if (error) {
            logger.error('Failed to close voice WebSocket server', {
              error,
            });
          }
          resolve();
        });
      });
      for (const client of wss.clients) {
        client.close(1001, 'Server shutdown');
      }

      const httpServerClosed = new Promise<void>(resolve => {
        httpServer.close(error => {
          if (error) {
            logger.error('Failed to close HTTP server', { error });
          } else {
            logger.info('HTTP server closed');
          }
          resolve();
        });
      });

      const voiceDrain = shutdownVoiceSessions();
      const whatsappOutboxShutdown = stopWhatsAppOutboxWorker();
      const whatsappShutdown = whatsappOutboxShutdown.then(() =>
        shutdownWhatsAppBridge()
      );
      const workerShutdown = Promise.allSettled([
        followUpWorker.close(),
        metricsWorker.close(),
      ]);
      const voiceResult = await voiceDrain;
      if (!voiceResult.drained) {
        logger.warn('Voice session shutdown deadline exceeded', {
          pendingWork: voiceResult.pendingWork,
          activeSessions: voiceResult.activeSessions,
          initializingSessions: voiceResult.initializingSessions,
        });
      } else {
        logger.info('Voice sessions drained');
      }

      // A peer may ignore the closing handshake. Finalization has already
      // completed (or reached its bounded deadline), so force transport close.
      for (const client of wss.clients) client.terminate();
      const workerResults = await workerShutdown;
      for (const result of workerResults) {
        if (result.status === 'rejected') {
          logger.error('Background worker shutdown failed', {
            error: result.reason,
          });
        }
      }
      await Promise.all([
        webSocketServerClosed,
        httpServerClosed,
        whatsappShutdown,
        whatsappOutboxShutdown,
      ]);
      process.exit(0);
    })();
    return shutdownPromise;
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch(error => {
      logger.error('Graceful shutdown failed', { error });
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch(error => {
      logger.error('Graceful shutdown failed', { error });
      process.exit(1);
    });
  });
}

main().catch(err => {
  logger.error('Failed to start server', { error: err });
  process.exit(1);
});
