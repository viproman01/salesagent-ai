import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../utils/logger';
import pool from '../db';
import { randomUUID } from 'crypto';
import { createStarterVoiceAgent } from '../agents/starter';

export const authRouter = Router();
const AUTH_COOKIE = 'salesagent_session';

function cookieMaxAgeMs(value: string): number {
  const match = /^(\d+)([dhm])$/.exec(value.trim());
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === 'd') return amount * 24 * 60 * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

function setAuthCookie(res: import('express').Response, token: string): void {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: cookieMaxAgeMs(config.JWT_EXPIRES_IN),
  });
}

function clearAuthCookie(res: import('express').Response): void {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

const registerSchema = z.object({
  orgName:  z.string().min(2).max(255),
  email:    z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2).max(255),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
});

// POST /api/v1/auth/register
authRouter.post('/register', async (req, res): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const { orgName, email, password, fullName } = parsed.data;

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const slug = orgName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  const client = await pool.connect();
  try {
    await client.beginTransaction();

    const orgId = randomUUID();
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [orgId, orgName, `${slug}-${Date.now()}`]
    );

    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, org_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, orgId, email, passwordHash, fullName]
    );

    // Создаём начальную подписку (trial)
    await client.query(
      `INSERT INTO subscriptions (id, org_id, plan) VALUES ($1, $2, 'trial')`,
      [randomUUID(), orgId]
    );

    // Новый аккаунт сразу готов к тестовому звонку.
    await createStarterVoiceAgent(client, orgId);

    await client.commit();

    const token = jwt.sign({ userId, orgId, role: 'admin' }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN as '7d',
    });

    setAuthCookie(res, token);
    logger.info('New organization registered', { orgId, email });
    res.status(201).json({ token, orgId, userId });
  } catch (err) {
    await client.rollback();
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/v1/auth/login
authRouter.post('/login', async (req, res): Promise<void> => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed' });
    return;
  }

  const { email, password } = parsed.data;

  const result = await pool.query<{
    id: string; org_id: string; password_hash: string; role: string; is_active: boolean;
  }>(
    'SELECT id, org_id, password_hash, role, is_active FROM users WHERE email = $1',
    [email]
  );

  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  if (!user.is_active) {
    res.status(403).json({ error: 'Account disabled' });
    return;
  }

  await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

  const token = jwt.sign(
    { userId: user.id, orgId: user.org_id, role: user.role },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN as '7d' }
  );

  setAuthCookie(res, token);
  res.json({ token, orgId: user.org_id, userId: user.id });
});

authRouter.get('/me', requireAuth, async (req, res): Promise<void> => {
  const auth = (req as typeof req & { user: JwtPayload }).user;
  const result = await pool.query<{
    id: string;
    org_id: string;
    email: string;
    full_name: string;
    role: string;
  }>(
    'SELECT id, org_id, email, full_name, role FROM users WHERE id = $1 AND is_active = true',
    [auth.userId]
  );
  const user = result.rows[0];
  if (!user) {
    clearAuthCookie(res);
    res.status(401).json({ error: 'Session user not found' });
    return;
  }
  res.json({
    userId: user.id,
    orgId: user.org_id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
  });
});

authRouter.post('/logout', (_req, res): void => {
  clearAuthCookie(res);
  res.status(204).end();
});

// Middleware: проверка JWT
export interface JwtPayload {
  userId: string;
  orgId:  string;
  role:   string;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(';')) {
    const [rawName, ...rawValue] = item.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

export function requireAuth(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : readCookie(req.headers.cookie, AUTH_COOKIE);
  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    (req as import('express').Request & { user: JwtPayload }).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
