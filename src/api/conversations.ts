import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type JwtPayload } from './auth';
import pool from '../db';
import { config } from '../config';
import {
  deliverWhatsAppOutboxItem,
  enqueueWhatsAppReply,
} from '../whatsapp/outbox';

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
    channel: z.enum(['whatsapp', 'telegram', 'voice', 'webchat']).optional(),
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
    conditions.push(`c.channel = $${paramIndex}::channel_type`);
    params.push(channel);
    paramIndex++;
  }
  if (status) {
    conditions.push(`c.status = $${paramIndex}::conversation_status`);
    params.push(status);
    paramIndex++;
  }

  const countParams = [...params];
  params.push(limit, offset);

  const result = await pool.query(
    `SELECT
       c.id, c.channel, c.status, c.message_count, c.duration_seconds,
       c.sentiment, c.quality_score, c.summary, c.started_at, c.ended_at,
       c.last_message_at, c.reply_mode, c.mode_version,
       l.phone, l.name AS lead_name, l.stage AS lead_stage,
       COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS whatsapp_opted_out,
       COALESCE(l.metadata->>'whatsappHumanHandoff' = 'true', false) AS whatsapp_handoff,
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
    `SELECT COUNT(*)::text FROM conversations c WHERE ${conditions.join(' AND ')}`,
    countParams
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
  const convResult = await pool.query<{
    org_id: string;
    channel: string;
    status: string;
    reply_mode: 'ai' | 'operator';
    mode_version: number;
    phone: string | null;
    whatsapp_jid: string | null;
    whatsapp_opted_out: boolean;
    whatsapp_handoff: boolean;
  }>(
    `SELECT c.org_id, c.channel, c.status, c.reply_mode, c.mode_version, l.phone,
            l.metadata->>'whatsappJid' AS whatsapp_jid,
            COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS whatsapp_opted_out,
            COALESCE(l.metadata->>'whatsappHumanHandoff' = 'true', false) AS whatsapp_handoff
     FROM conversations c
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.id = $1`,
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
            tokens_input, tokens_output, latency_ms, created_at,
            sender_type, author_user_id, delivery_status,
            external_id, provider_message_id, sequence_id
     FROM (
       SELECT id, role, content, tool_name, tool_input, tool_result,
              tokens_input, tokens_output, latency_ms, created_at,
              sender_type, author_user_id, delivery_status,
              external_id, provider_message_id, sequence_id
       FROM messages
       WHERE conversation_id = $1
       ORDER BY sequence_id DESC
       LIMIT 500
     ) recent
     ORDER BY sequence_id ASC`,
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
    conversation: convResult.rows[0],
    limits: {
      whatsappOutboundMaxChars: config.WHATSAPP_OUTBOUND_MAX_CHARS,
    },
  });
});

const replyModeSchema = z.object({
  mode: z.enum(['ai', 'operator']),
  expectedVersion: z.number().int().min(0),
}).strict();

conversationsRouter.patch(
  '/:convId/reply-mode',
  requireAuth,
  async (req, res, next): Promise<void> => {
    const user = (req as typeof req & { user: JwtPayload }).user;
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      res.status(403).json({ error: 'Administrator access required' });
      return;
    }
    const parsed = replyModeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid reply mode request' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        org_id: string;
        channel: string;
        status: string;
        lead_id: string | null;
        reply_mode: 'ai' | 'operator';
        mode_version: number;
        opted_out: boolean;
      }>(
        `SELECT c.org_id, c.channel, c.status, c.lead_id, c.reply_mode, c.mode_version,
                COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out
         FROM conversations c
         LEFT JOIN leads l ON l.id = c.lead_id
         WHERE c.id = $1
         FOR UPDATE OF c`,
        [req.params['convId']!]
      );
      const conversation = current.rows[0];
      if (!conversation) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      if (conversation.org_id !== user.orgId) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (conversation.channel !== 'whatsapp') {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Reply mode is available for WhatsApp only' });
        return;
      }
      if (conversation.status !== 'active') {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Conversation is not active' });
        return;
      }
      if (conversation.mode_version !== parsed.data.expectedVersion) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'Conversation mode changed',
          modeVersion: conversation.mode_version,
        });
        return;
      }
      if (conversation.reply_mode === parsed.data.mode) {
        await client.query('COMMIT');
        res.json({
          reply_mode: conversation.reply_mode,
          mode_version: conversation.mode_version,
        });
        return;
      }
      if (conversation.opted_out && parsed.data.mode === 'ai') {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'Contact opted out; only an inbound START command can resume AI',
        });
        return;
      }

      const updated = await client.query<{
        reply_mode: 'ai' | 'operator';
        mode_version: number;
      }>(
        `UPDATE conversations
         SET reply_mode = $1, mode_version = mode_version + 1,
             assigned_user_id = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING reply_mode, mode_version`,
        [
          parsed.data.mode,
          parsed.data.mode === 'operator' ? user.userId : null,
          req.params['convId']!,
        ]
      );
      if (conversation.lead_id) {
        await client.query(
          `UPDATE leads
           SET metadata = metadata || $1::jsonb, updated_at = NOW()
           WHERE id = $2 AND org_id = $3`,
          [
            JSON.stringify({
              whatsappHumanHandoff: parsed.data.mode === 'operator',
              whatsappStateUpdatedAt: new Date().toISOString(),
            }),
            conversation.lead_id,
            user.orgId,
          ]
        );
      }
      const cancelled = await client.query<{ message_id: string }>(
        `UPDATE whatsapp_outbox
         SET status = 'cancelled', locked_at = NULL, updated_at = NOW()
         WHERE conversation_id = $1
           AND status IN ('pending', 'failed', 'sending')
           AND required_mode IS NOT NULL
           AND required_mode <> $2
         RETURNING message_id`,
        [req.params['convId']!, parsed.data.mode]
      );
      if (cancelled.rows.length > 0) {
        await client.query(
          `UPDATE messages SET delivery_status = 'cancelled'
           WHERE id = ANY($1::uuid[])`,
          [cancelled.rows.map(row => row.message_id)]
        );
      }
      await client.query('COMMIT');
      res.json(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      next(error);
    } finally {
      client.release();
    }
  }
);

const operatorReplySchema = z.object({
  text: z.string().trim().min(1).max(config.WHATSAPP_OUTBOUND_MAX_CHARS),
  clientRequestId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
}).strict();

conversationsRouter.post(
  '/:convId/replies',
  requireAuth,
  async (req, res, next): Promise<void> => {
    const user = (req as typeof req & { user: JwtPayload }).user;
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      res.status(403).json({ error: 'Administrator access required' });
      return;
    }
    const parsed = operatorReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid operator reply' });
      return;
    }

    const client = await pool.connect();
    let outboxId: string | undefined;
    let messageId: string | undefined;
    let created = false;
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        org_id: string;
        channel: string;
        reply_mode: 'ai' | 'operator';
        mode_version: number;
        phone: string | null;
        whatsapp_jid: string | null;
        opted_out: boolean;
        status: string;
        last_inbound_at: Date | null;
      }>(
        `SELECT c.org_id, c.channel, c.reply_mode, c.mode_version, c.status, l.phone,
                l.metadata->>'whatsappJid' AS whatsapp_jid,
                COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
                (
                  SELECT MAX(m.created_at)
                  FROM messages m
                  WHERE m.conversation_id = c.id AND m.sender_type = 'customer'
                ) AS last_inbound_at
         FROM conversations c
         LEFT JOIN leads l ON l.id = c.lead_id
         WHERE c.id = $1
         FOR UPDATE OF c`,
        [req.params['convId']!]
      );
      const conversation = current.rows[0];
      if (!conversation) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      if (conversation.org_id !== user.orgId) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (conversation.channel !== 'whatsapp') {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Operator replies are available for WhatsApp only' });
        return;
      }
      if (conversation.status !== 'active') {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Conversation is not active' });
        return;
      }
      if (
        conversation.reply_mode !== 'operator' ||
        conversation.mode_version !== parsed.data.expectedVersion
      ) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'Enable operator mode before replying',
          replyMode: conversation.reply_mode,
          modeVersion: conversation.mode_version,
        });
        return;
      }
      if (conversation.opted_out) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Contact opted out; resume explicitly first' });
        return;
      }
      if (!conversation.phone || !conversation.whatsapp_jid) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Verified inbound WhatsApp identity is missing' });
        return;
      }
      if (
        !conversation.last_inbound_at ||
        Date.now() - new Date(conversation.last_inbound_at).getTime() >
          24 * 60 * 60 * 1_000
      ) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'The 24-hour inbound reply window has expired',
        });
        return;
      }

      const queued = await enqueueWhatsAppReply(client, {
        orgId: user.orgId,
        conversationId: String(req.params['convId']),
        phone: conversation.phone,
        replyJid: conversation.whatsapp_jid,
        text: parsed.data.text,
        senderType: 'operator',
        authorUserId: user.userId,
        kind: 'operator',
        idempotencyKey: `operator:${user.userId}:${parsed.data.clientRequestId}`,
        requiredMode: 'operator',
        requiredVersion: conversation.mode_version,
      });
      outboxId = queued.outboxId;
      messageId = queued.messageId;
      created = queued.created;
      await client.query(
        `UPDATE conversations
         SET assigned_user_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [user.userId, req.params['convId']!]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      next(error);
      return;
    } finally {
      client.release();
    }

    try {
      const delivery = await deliverWhatsAppOutboxItem(outboxId!);
      res.status(created ? 201 : 200).json({
        messageId,
        deliveryStatus: delivery.status,
        providerMessageId: delivery.messageId,
      });
    } catch (error) {
      next(error);
    }
  }
);
