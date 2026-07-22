import { Router, type Request } from 'express';
import { requireAuth, type JwtPayload } from './auth';
import { whatsappBridge } from '../channels/whatsapp';
import pool from '../db';
import { config } from '../config';
import { isWhatsAppOutboxWorkerRunning } from '../whatsapp/outbox';

export const whatsappRouter = Router();

type AuthenticatedRequest = Request & { user: JwtPayload };

whatsappRouter.use(requireAuth);
whatsappRouter.use((req, res, next): void => {
  res.setHeader('Cache-Control', 'no-store');
  const { role } = (req as AuthenticatedRequest).user;
  if (role !== 'admin' && role !== 'superadmin') {
    res.status(403).json({ error: 'Administrator access required' });
    return;
  }
  next();
});

whatsappRouter.get('/status', async (req, res, next): Promise<void> => {
  try {
    const { orgId } = (req as AuthenticatedRequest).user;
    const activeAgent = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agents
         WHERE org_id = $1 AND is_active = true AND 'whatsapp' = ANY(channels)
       ) AS exists`,
      [orgId]
    );
    const hasActiveAgent = activeAgent.rows[0]?.exists ?? false;
    const outboxWorker = isWhatsAppOutboxWorkerRunning();
    res.json({
      ...whatsappBridge.getStatus(orgId),
      automation: {
        enabled: config.TEXT_CHAT_ENABLED,
        activeAgent: hasActiveAgent,
        outboxWorker,
        ready: config.TEXT_CHAT_ENABLED && hasActiveAgent && outboxWorker,
      },
      limits: {
        outboundMaxChars: config.WHATSAPP_OUTBOUND_MAX_CHARS,
      },
    });
  } catch (error) {
    next(error);
  }
});

whatsappRouter.post('/connect', async (req, res, next): Promise<void> => {
  try {
    const { orgId } = (req as AuthenticatedRequest).user;
    res.status(202).json(await whatsappBridge.connect(orgId));
  } catch (error) {
    next(error);
  }
});

whatsappRouter.post('/reconnect', async (req, res, next): Promise<void> => {
  try {
    const { orgId } = (req as AuthenticatedRequest).user;
    res.status(202).json(await whatsappBridge.reconnect(orgId));
  } catch (error) {
    next(error);
  }
});

whatsappRouter.post('/logout', async (req, res, next): Promise<void> => {
  try {
    const { orgId } = (req as AuthenticatedRequest).user;
    res.json(await whatsappBridge.logout(orgId));
  } catch (error) {
    next(error);
  }
});

// Recovery endpoint for a corrupt local session. Unlike logout it cannot
// notify WhatsApp, so the device may still need to be removed in the phone UI.
whatsappRouter.post('/reset', async (req, res, next): Promise<void> => {
  try {
    const { orgId } = (req as AuthenticatedRequest).user;
    res.json(await whatsappBridge.reset(orgId));
  } catch (error) {
    next(error);
  }
});
