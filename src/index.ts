import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { closeDb, testConnection } from './db';
import { authRouter } from './api/auth';
import { dashboardRouter } from './api/dashboard';
import { conversationsRouter } from './api/conversations';
import { knowledgeRouter } from './api/knowledge';
import { agentsRouter } from './api/agents';
import { recordingsRouter } from './api/recordings';
import { publicVoiceRouter, voiceRouter } from './api/voice';
import { providersRouter } from './api/providers';
import { chatRouter } from './api/chat';
import { systemRouter } from './api/system';
import { handleWhatsAppWebhook } from './channels/whatsapp';
import { handleTelegramWebhook } from './channels/telegram';
import { followUpWorker } from './orchestrator/follow-up';
import { metricsWorker } from './analytics/metrics';
import { globalErrorHandler } from './middleware/errorHandler';
import { apiLimit, chatLimit, webhookLimit } from './middleware/rateLimit';
import { requireTelegramWebhook, requireWazzupWebhook } from './middleware/webhookAuth';
import { runMigrations } from './migrations';

async function main() {
  if (config.AUTO_MIGRATE) {
    await runMigrations();
  }
  // Проверяем подключение к БД
  await testConnection();
  logger.info('Database connected');

  const app = express();
  app.set('trust proxy', 1);

  // ---- Безопасность ----
  // sslip.io is currently exposed over plain HTTP. Helmet's default
  // upgrade-insecure-requests would make the browser fetch the SPA bundle over
  // HTTPS, where this allocation has no listener, resulting in a white page.
  const publicUrl = config.PUBLIC_BASE_URL ?? config.API_BASE_URL;
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: publicUrl.startsWith('https://') ? [] : null,
        mediaSrc: ["'self'", 'blob:', 'data:'],
      },
    },
  }));
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'microphone=(self), speaker-selection=(self)');
    next();
  });
  app.use(cors({
    origin: (origin, callback) => {
      const temporaryTunnel = config.CLOUDFLARE_TUNNEL_MODE === 'quick'
        && Boolean(origin?.endsWith('.trycloudflare.com'));
      if (!origin || origin === config.FRONTEND_URL || temporaryTunnel) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }));
  app.use(compression());

  // ---- Rate limiting (granular per endpoint type) ----
  app.use('/api/v1/conversations', chatLimit);
  app.use('/api/v1/', apiLimit);
  app.use('/api/voice', webhookLimit);
  app.use('/api/webhooks', webhookLimit);

  // ---- Парсинг тела ----
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ---- Health check ----
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.get('/https-url', (_req, res) => {
    const urlFile = path.resolve(process.env['CLOUDFLARE_URL_FILE'] ?? path.join(process.cwd(), 'https-url.txt'));
    try {
      const url = fs.readFileSync(urlFile, 'utf8').trim();
      if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(url)) {
        res.json({ url, permanent: false });
        return;
      }
    } catch { /* tunnel has not published a URL yet */ }
    res.status(503).json({ error: 'HTTPS tunnel is starting' });
  });

  // ---- REST API ----
  app.use('/api/v1/auth',           authRouter);
  app.use('/api/v1/dashboard',      dashboardRouter);
  app.use('/api/v1/conversations',  conversationsRouter);
  app.use('/api/v1/knowledge',      knowledgeRouter);
  app.use('/api/v1/agents',         agentsRouter);
  app.use('/api/v1/recordings',     recordingsRouter);
  app.use('/api/v1/voice',          voiceRouter);
  app.use('/api/v1/providers',      providersRouter);
  app.use('/api/v1/chat',           chatRouter);
  app.use('/api/v1/system',         systemRouter);

  // Public Voximplant turn-taking endpoint. It authenticates with
  // X-Voice-Secret rather than a browser JWT.
  app.use('/api/voice', publicVoiceRouter);

  // ---- Webhooks ----
  app.post('/api/webhooks/whatsapp/:orgId', requireWazzupWebhook, handleWhatsAppWebhook);
  app.post('/api/webhooks/telegram/:orgId', requireTelegramWebhook, handleTelegramWebhook);

  // Webhook AmoCRM (OAuth callback)
  app.get('/api/crm/amocrm/callback', async (req, res) => {
    // TODO: обработка OAuth callback от AmoCRM
    res.json({ ok: true, code: req.query['code'] });
  });

  // Serverix runs one Node entrypoint. When the admin bundle is uploaded next
  // to it, serve the SPA from the same origin as the API.
  const adminDist = path.join(process.cwd(), 'admin', 'dist');
  if (fs.existsSync(adminDist)) {
    app.use(express.static(adminDist, {
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-store');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=300');
        }
      },
    }));
    app.get('/*splat', (req, res, next) => {
      if (req.path === '/health' || req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(adminDist, 'index.html'));
    });
  }

  // ---- Обработка ошибок ----
  app.use(globalErrorHandler);

  // ---- HTTP server ----
  const httpServer = createServer(app);

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
      void closeDb().then(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main().catch(err => {
  logger.error('Failed to start server', { error: err });
  process.exit(1);
});
