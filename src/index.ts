import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
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
import { handleWhatsAppWebhook } from './channels/whatsapp';
import { handleTelegramWebhook } from './channels/telegram';
import { handleVoximplantWebhook, handleVoiceWebSocket } from './channels/voice';
import { followUpWorker } from './orchestrator/follow-up';
import { metricsWorker } from './analytics/metrics';

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
    methods:     ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }));
  app.use(compression());

  // ---- Rate limiting (100 req/min per IP) ----
  const limiter = rateLimit({
    windowMs:      config.RATE_LIMIT_WINDOW_MS,
    max:           config.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many requests, please try again later' },
  });
  app.use('/api/', limiter);

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

  // ---- Webhooks ----
  app.post('/api/webhooks/whatsapp',   handleWhatsAppWebhook);
  app.post('/api/webhooks/telegram',   handleTelegramWebhook);
  app.post('/api/webhooks/voximplant', handleVoximplantWebhook);

  // Webhook AmoCRM (OAuth callback)
  app.get('/api/crm/amocrm/callback', async (req, res) => {
    // TODO: обработка OAuth callback от AmoCRM
    res.json({ ok: true, code: req.query['code'] });
  });

  // ---- Обработка ошибок ----
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  // ---- HTTP + WebSocket сервер ----
  const httpServer = createServer(app);

  const wss = new WebSocketServer({ server: httpServer, path: '/ws/voice' });
  wss.on('connection', (ws, req) => {
    handleVoiceWebSocket(ws, req).catch(err => {
      logger.error('Voice WebSocket handler error', { error: err });
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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    await followUpWorker.close();
    await metricsWorker.close();
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch(err => {
  logger.error('Failed to start server', { error: err });
  process.exit(1);
});
