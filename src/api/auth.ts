import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../utils/logger';
import pool from '../db';

export const authRouter = Router();

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
    await client.query('BEGIN');

    const orgResult = await client.query<{ id: string }>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
      [orgName, `${slug}-${Date.now()}`]
    );
    const orgId = orgResult.rows[0]!.id;

    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (org_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, email, passwordHash, fullName]
    );
    const userId = userResult.rows[0]!.id;

    // Создаём начальную подписку (trial)
    await client.query(
      `INSERT INTO subscriptions (org_id, plan) VALUES ($1, 'trial')`,
      [orgId]
    );

    await client.query('COMMIT');

    const token = jwt.sign({ userId, orgId, role: 'admin' }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN as '7d',
    });

    logger.info('New organization registered', { orgId, email });
    res.status(201).json({ token, orgId, userId });
  } catch (err) {
    await client.query('ROLLBACK');
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

  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  const token = jwt.sign(
    { userId: user.id, orgId: user.org_id, role: user.role },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN as '7d' }
  );

  res.json({ token, orgId: user.org_id, userId: user.id });
});

// Middleware: проверка JWT
export interface JwtPayload {
  userId: string;
  orgId:  string;
  role:   string;
}

export function requireAuth(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  try {
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    (req as import('express').Request & { user: JwtPayload }).user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
