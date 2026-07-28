import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';

export function secretsMatch(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(req: Request): string | undefined {
  const authorization = req.header('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
}

function requireSecret(
  expected: string | undefined,
  candidates: Array<string | undefined>,
  res: Response,
  next: NextFunction
): void {
  if (!expected) {
    res.status(503).json({ error: 'Webhook secret is not configured' });
    return;
  }
  if (!candidates.some(candidate => secretsMatch(candidate, expected))) {
    res.status(401).json({ error: 'Invalid webhook secret' });
    return;
  }
  next();
}

export function requireTelegramWebhook(req: Request, res: Response, next: NextFunction): void {
  requireSecret(
    config.TELEGRAM_WEBHOOK_SECRET,
    [req.header('x-telegram-bot-api-secret-token')],
    res,
    next
  );
}

export function requireWazzupWebhook(req: Request, res: Response, next: NextFunction): void {
  requireSecret(
    config.WAZZUP24_WEBHOOK_SECRET,
    [req.header('x-wazzup-secret'), req.header('x-webhook-secret'), bearerToken(req)],
    res,
    next
  );
}
