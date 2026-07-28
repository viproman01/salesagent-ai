import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type JwtPayload } from './auth';
import pool from '../db';

export const conversationsRouter = Router();

// GET /api/v1/conversations/:orgId
conversationsRouter.get('/:orgId', requireAuth, async (req, res): Promise<void> => {
  const user  = (req as typeof req & { user: JwtPayload }).user;
  const orgId = req.params['orgId']!;

  if (user.orgId !== orgId) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const querySchema = z.object({
    channel: z.enum(['whatsapp', 'telegram', 'voice']).optional(),
    status:  z.enum(['active', 'completed', 'failed', 'timeout']).optional(),
    limit:   z.string().default('50').transform(Number),
    offset:  z.string().default('0').transform(Number),
  });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query params' });
    return;
  }

  const { channel, status, limit, offset } = parsed.data;

  const conditions: string[] = ['c.org_id = $1'];
  const params: unknown[] = [orgId];
  let paramIndex = 2;

  if (channel) {
    conditions.push(`c.channel = $${paramIndex}`);
    params.push(channel);
    paramIndex++;
  }
  if (status) {
    conditions.push(`c.status = $${paramIndex}`);
    params.push(status);
    paramIndex++;
  }

  params.push(limit, offset);

  const result = await pool.query(
    `SELECT
       c.id, c.channel, c.status, c.message_count, c.duration_seconds,
       c.sentiment, c.quality_score, c.summary, c.started_at, c.ended_at,
       c.last_message_at,
       l.phone, l.name AS lead_name, l.stage AS lead_stage,
       a.name AS agent_name
     FROM conversations c
     LEFT JOIN leads l ON l.id = c.lead_id
     LEFT JOIN agents a ON a.id = c.agent_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY c.created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    params
  );

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM conversations c WHERE ${conditions.join(' AND ')}`,
    params.slice(0, paramIndex - 1)
  );

  res.json({
    conversations: result.rows,
    total:         parseInt(countResult.rows[0]?.count ?? '0'),
    limit,
    offset,
  });
});

// GET /api/v1/conversations/:convId/messages
conversationsRouter.get('/:convId/messages', requireAuth, async (req, res): Promise<void> => {
  const user   = (req as typeof req & { user: JwtPayload }).user;
  const convId = req.params['convId']!;

  // Проверяем принадлежность разговора к организации
  const convResult = await pool.query<{ org_id: string }>(
    'SELECT org_id FROM conversations WHERE id = $1',
    [convId]
  );
  if (convResult.rows.length === 0) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  if (convResult.rows[0]!.org_id !== user.orgId) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const messages = await pool.query(
    `SELECT id, role, content, tool_name, tool_input, tool_result,
            tokens_input, tokens_output, latency_ms, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [convId]
  );

  // Получаем запись звонка если есть
  const recording = await pool.query(
    `SELECT id, s3_key, duration_seconds, transcript, highlights, quality_score
     FROM call_recordings WHERE conversation_id = $1`,
    [convId]
  );

  res.json({
    messages:  messages.rows,
    recording: recording.rows[0] ?? null,
  });
});
