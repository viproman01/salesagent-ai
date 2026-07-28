import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requireAuth, type JwtPayload } from './auth';
import { logger } from '../utils/logger';

export const systemRouter = Router();

const clientErrorSchema = z.object({
  message: z.string().min(1).max(500),
  name: z.string().max(100).optional(),
  route: z.string().max(300).optional(),
  buildId: z.string().max(100).optional(),
  stack: z.string().max(4000).optional(),
});

systemRouter.get('/version', (_req: Request, res: Response): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    buildId: config.APP_BUILD_ID,
    nodeEnv: config.NODE_ENV,
  });
});

systemRouter.post('/client-errors', requireAuth, (req: Request, res: Response): void => {
  const parsed = clientErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid client error report' });
    return;
  }
  const user = (req as Request & { user: JwtPayload }).user;
  logger.error('Frontend error reported', {
    orgId: user.orgId,
    userId: user.userId,
    client: parsed.data,
  });
  res.status(204).end();
});
