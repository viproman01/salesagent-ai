import { createHash } from 'node:crypto';
import pool from '../db';
import { config } from '../config';
import {
  deliverWhatsAppOutboxItem,
  enqueueWhatsAppReply,
  type WhatsAppDeliveryStatus,
} from './outbox';

export type PolicyGatedSendResult = Readonly<{
  accepted: boolean;
  status?: WhatsAppDeliveryStatus;
  reason?: 'conversation_unavailable' | 'policy_blocked' | 'invalid_text';
}>;

/**
 * The only supported path for an AI tool to send an additional WhatsApp
 * message. Identity, consent, mode and the 24-hour inbound window are loaded
 * from the database; caller-provided phone/JID values are intentionally ignored.
 */
export async function sendPolicyGatedWhatsAppReply(input: Readonly<{
  orgId: string;
  conversationId: string;
  text: string;
}>): Promise<PolicyGatedSendResult> {
  const text = input.text.trim();
  if (!text || [...text].length > config.WHATSAPP_OUTBOUND_MAX_CHARS) {
    return { accepted: false, reason: 'invalid_text' };
  }

  const client = await pool.connect();
  let outboxId: string | undefined;
  try {
    await client.query('BEGIN');
    const state = await client.query<{
      reply_mode: 'ai' | 'operator';
      mode_version: number;
      status: string;
      phone: string | null;
      whatsapp_jid: string | null;
      opted_out: boolean;
      last_customer_at: Date | null;
      last_customer_sequence: string | null;
    }>(
      `SELECT c.reply_mode, c.mode_version, c.status, l.phone,
              l.metadata->>'whatsappJid' AS whatsapp_jid,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
              customer.created_at AS last_customer_at,
              customer.sequence_id::text AS last_customer_sequence
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       LEFT JOIN LATERAL (
         SELECT created_at, sequence_id
         FROM messages
         WHERE conversation_id = c.id AND sender_type = 'customer'
         ORDER BY sequence_id DESC
         LIMIT 1
       ) customer ON true
       WHERE c.id = $1 AND c.org_id = $2
       FOR UPDATE OF c`,
      [input.conversationId, input.orgId]
    );
    const current = state.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return { accepted: false, reason: 'conversation_unavailable' };
    }
    if (
      current.status !== 'active' ||
      current.reply_mode !== 'ai' ||
      current.opted_out ||
      !current.phone ||
      !current.whatsapp_jid ||
      !current.last_customer_at ||
      !current.last_customer_sequence ||
      Date.now() - new Date(current.last_customer_at).getTime() >
        24 * 60 * 60 * 1_000
    ) {
      await client.query('ROLLBACK');
      return { accepted: false, reason: 'policy_blocked' };
    }

    const digest = createHash('sha256').update(text).digest('hex').slice(0, 24);
    const queued = await enqueueWhatsAppReply(client, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      phone: current.phone,
      replyJid: current.whatsapp_jid,
      text,
      senderType: 'ai',
      kind: 'ai',
      idempotencyKey:
        `tool:${input.conversationId}:${current.last_customer_sequence}:${digest}`,
      requiredMode: 'ai',
      requiredVersion: current.mode_version,
    });
    outboxId = queued.outboxId;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const delivery = await deliverWhatsAppOutboxItem(outboxId!);
  return { accepted: delivery.status !== 'cancelled', status: delivery.status };
}
