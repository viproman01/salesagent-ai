import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type JwtPayload } from './auth';
import pool from '../db';

export const agentsRouter = Router();

const agentSchema = z.object({
  name:          z.string().min(1).max(100),
  system_prompt: z.string().min(10),
  channels:      z.array(z.enum(['whatsapp', 'telegram', 'voice'])).min(1),
  voice_config:  z.object({
    voice:    z.string().default('Aoede'),
    language: z.string().default('ru-RU'),
    speed:    z.number().min(0.5).max(2.0).default(1.0),
    fish_reference_id: z.string().uuid().optional(),
    greeting: z.string().min(1).max(300).optional(),
  }).optional(),
  temperature:   z.number().min(0).max(1).default(0.7),
  max_tokens:    z.number().min(64).max(4096).default(1024),
  is_active:     z.boolean().default(true),
});

// GET /api/v1/agents
agentsRouter.get('/', requireAuth, async (req, res): Promise<void> => {
  const user = (req as typeof req & { user: JwtPayload }).user;

  const result = await pool.query(
    `SELECT id, name, channels, voice_config, model_text, model_voice,
            temperature, max_tokens, is_active, created_at
     FROM agents WHERE org_id = $1 ORDER BY created_at DESC`,
    [user.orgId]
  );
  res.json({ agents: result.rows });
});

// GET /api/v1/agents/:id
agentsRouter.get('/:id', requireAuth, async (req, res): Promise<void> => {
  const user = (req as typeof req & { user: JwtPayload }).user;

  const result = await pool.query(
    'SELECT * FROM agents WHERE id = $1 AND org_id = $2',
    [req.params['id'], user.orgId]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  res.json(result.rows[0]);
});

// POST /api/v1/agents
agentsRouter.post('/', requireAuth, async (req, res): Promise<void> => {
  const user   = (req as typeof req & { user: JwtPayload }).user;
  const parsed = agentSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  const d = parsed.data;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO agents
       (org_id, name, system_prompt, channels, voice_config, temperature, max_tokens, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      user.orgId, d.name, d.system_prompt,
      d.channels,
      JSON.stringify(d.voice_config ?? { voice: 'Aoede', language: 'ru-RU', speed: 1.0 }),
      d.temperature, d.max_tokens, d.is_active,
    ]
  );
  res.status(201).json({ id: result.rows[0]!.id });
});

// PUT /api/v1/agents/:id
agentsRouter.put('/:id', requireAuth, async (req, res): Promise<void> => {
  const user   = (req as typeof req & { user: JwtPayload }).user;
  const parsed = agentSchema.partial().safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    return;
  }

  // Строим SET clause динамически
  const d = parsed.data;
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const fieldMap: Record<string, unknown> = {
    name:          d.name,
    system_prompt: d.system_prompt,
    channels:      d.channels,
    voice_config:  d.voice_config ? JSON.stringify(d.voice_config) : undefined,
    temperature:   d.temperature,
    max_tokens:    d.max_tokens,
    is_active:     d.is_active,
  };

  for (const [key, val] of Object.entries(fieldMap)) {
    if (val !== undefined) {
      fields.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }
  }

  if (fields.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  values.push(req.params['id'], user.orgId);
  await pool.query(
    `UPDATE agents SET ${fields.join(', ')}, updated_at = NOW()
     WHERE id = $${idx} AND org_id = $${idx + 1}`,
    values
  );

  res.json({ success: true });
});

// DELETE /api/v1/agents/:id
agentsRouter.delete('/:id', requireAuth, async (req, res): Promise<void> => {
  const user = (req as typeof req & { user: JwtPayload }).user;
  await pool.query(
    'UPDATE agents SET is_active = false WHERE id = $1 AND org_id = $2',
    [req.params['id'], user.orgId]
  );
  res.json({ success: true });
});
