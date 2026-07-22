import type { PoolClient } from 'pg';
import pool from '../db';
import { logger } from '../utils/logger';
import {
  sendWhatsAppMessage,
  whatsappBridge,
} from '../channels/whatsapp';

export type WhatsAppOutboxKind =
  | 'ai'
  | 'control'
  | 'operator'
  | 'rate_limit'
  | 'follow_up';

export type WhatsAppDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export type EnqueueWhatsAppReplyInput = Readonly<{
  orgId: string;
  conversationId: string;
  phone: string;
  replyJid: string;
  text: string;
  senderType: 'ai' | 'operator';
  authorUserId?: string;
  kind: WhatsAppOutboxKind;
  idempotencyKey: string;
  requiredMode?: 'ai' | 'operator';
  requiredVersion?: number;
  tokensInput?: number;
  tokensOutput?: number;
  latencyMs?: number;
}>;

export type EnqueueWhatsAppReplyResult = Readonly<{
  outboxId: string;
  messageId: string;
  created: boolean;
}>;

export type WhatsAppDeliveryResult = Readonly<{
  status: WhatsAppDeliveryStatus;
  messageId?: string;
}>;

type ClaimedOutboxRow = Readonly<{
  id: string;
  org_id: string;
  conversation_id: string;
  message_id: string;
  phone: string;
  reply_jid: string;
  text: string;
  kind: WhatsAppOutboxKind;
  idempotency_key: string;
  required_mode: 'ai' | 'operator' | null;
  required_version: number | null;
  attempts: number;
  created_at: Date;
}>;

type CandidateOutboxRow = ClaimedOutboxRow & Readonly<{
  status: WhatsAppDeliveryStatus;
  provider_message_id: string | null;
  locked_at: Date | null;
  stale_sending: boolean;
}>;

type DeliveryPolicyState = Readonly<{
  status: string;
  reply_mode: 'ai' | 'operator';
  mode_version: number;
  opted_out: boolean;
  current_whatsapp_jid: string | null;
  recent_customer: boolean;
  customer_after_outbox: boolean;
}>;

type OutboxClaim =
  | Readonly<{ action: 'send'; item: ClaimedOutboxRow }>
  | Readonly<{ action: 'return'; result: WhatsAppDeliveryResult }>;

const MAX_DELIVERY_ATTEMPTS = 8;
const DELIVERY_BATCH_SIZE = 20;
const DELIVERY_INTERVAL_MS = 2_000;
const DELIVERY_LEASE_INTERVAL = '2 minutes';
const SEND_TIMEOUT_MS = 15_000;

let workerTimer: NodeJS.Timeout | undefined;
let drainPromise: Promise<void> | undefined;

export async function enqueueWhatsAppReply(
  client: PoolClient,
  input: EnqueueWhatsAppReplyInput
): Promise<EnqueueWhatsAppReplyResult> {
  const existing = await client.query<{ id: string; message_id: string }>(
    `SELECT id, message_id
     FROM whatsapp_outbox
     WHERE org_id = $1 AND idempotency_key = $2`,
    [input.orgId, input.idempotencyKey]
  );
  if (existing.rows[0]) {
    return {
      outboxId: existing.rows[0].id,
      messageId: existing.rows[0].message_id,
      created: false,
    };
  }

  const externalId = `wa-out:${input.idempotencyKey}`.slice(0, 255);
  const message = await client.query<{ id: string }>(
    `INSERT INTO messages (
       conversation_id, role, content, sender_type, author_user_id,
       delivery_status, external_id, tokens_input, tokens_output, latency_ms
     ) VALUES (
       $1, 'assistant', $2, $3, $4, 'pending', $5, $6, $7, $8
     )
     RETURNING id`,
    [
      input.conversationId,
      input.text,
      input.senderType,
      input.authorUserId ?? null,
      externalId,
      input.tokensInput ?? null,
      input.tokensOutput ?? null,
      input.latencyMs ?? null,
    ]
  );
  const messageId = message.rows[0]!.id;
  const outbox = await client.query<{ id: string }>(
    `INSERT INTO whatsapp_outbox (
       org_id, conversation_id, message_id, phone, reply_jid, text, kind,
       idempotency_key, required_mode, required_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.orgId,
      input.conversationId,
      messageId,
      input.phone,
      input.replyJid,
      input.text,
      input.kind,
      input.idempotencyKey,
      input.requiredMode ?? null,
      input.requiredVersion ?? null,
    ]
  );
  await client.query(
    `UPDATE subscriptions
     SET messages_used = messages_used + 1, updated_at = NOW()
     WHERE org_id = $1`,
    [input.orgId]
  );
  return {
    outboxId: outbox.rows[0]!.id,
    messageId,
    created: true,
  };
}

export async function deliverWhatsAppOutboxItem(
  outboxId: string
): Promise<WhatsAppDeliveryResult> {
  const claim = await claimWhatsAppOutboxItem(outboxId);
  if (claim.action === 'return') return claim.result;

  const { item } = claim;
  const revalidated = await revalidateClaimedWhatsAppOutboxItem(item);
  if (revalidated.action === 'return') return revalidated.result;
  let providerMessageId: string;
  try {
    providerMessageId = await boundedSend(
      sendWhatsAppMessage(
        item.org_id,
        item.phone,
        item.text,
        item.reply_jid,
        item.idempotency_key
      )
    );
  } catch (error) {
    const result = await finalizeFailedOutboxItem(item, error);
    logger.warn('WhatsApp outbox delivery failed', {
      orgId: item.org_id,
      outboxId: item.id,
      code: safeDeliveryErrorCode(error),
      attempt: item.attempts,
    });
    return result;
  }
  return finalizeSentOutboxItem(item, providerMessageId);
}

async function claimWhatsAppOutboxItem(
  outboxId: string
): Promise<OutboxClaim> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidateResult = await client.query<CandidateOutboxRow>(
      `SELECT id, org_id, conversation_id, message_id, phone, reply_jid,
              text, kind, idempotency_key, required_mode,
              required_version, attempts, status, provider_message_id,
              locked_at, created_at,
              (status = 'sending'
                AND locked_at < NOW() - $2::interval) AS stale_sending
       FROM whatsapp_outbox
       WHERE id = $1`,
      [outboxId, DELIVERY_LEASE_INTERVAL]
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) {
      await client.query('COMMIT');
      return { action: 'return', result: { status: 'cancelled' } };
    }

    // Every writer locks the conversation before touching its outbox rows.
    // The transaction is committed before any network I/O, so STOP and
    // operator handoff can never wait on a stalled WhatsApp socket.
    const conversation = await client.query<DeliveryPolicyState>(
      `SELECT c.status::text AS status, c.reply_mode, c.mode_version,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
              l.metadata->>'whatsappJid' AS current_whatsapp_jid,
              EXISTS (
                SELECT 1 FROM messages recent
                WHERE recent.conversation_id = c.id
                  AND recent.sender_type = 'customer'
                  AND recent.created_at >= NOW() - INTERVAL '24 hours'
              ) AS recent_customer,
              EXISTS (
                SELECT 1 FROM messages newer
                WHERE newer.conversation_id = c.id
                  AND newer.sender_type = 'customer'
                  AND newer.created_at > $3::timestamptz
              ) AS customer_after_outbox
       FROM conversations c
       LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.id = $1 AND c.org_id = $2
       FOR UPDATE OF c`,
      [candidate.conversation_id, candidate.org_id, candidate.created_at]
    );

    if (
      candidate.attempts >= MAX_DELIVERY_ATTEMPTS &&
      (candidate.status === 'pending' || candidate.stale_sending)
    ) {
      await markTerminalFailure(client, candidate);
      const result = await currentDeliveryResult(client, candidate.id);
      await client.query('COMMIT');
      return { action: 'return', result };
    }

    const claimed = await client.query<ClaimedOutboxRow>(
      `UPDATE whatsapp_outbox AS target
       SET status = 'sending', attempts = attempts + 1,
           locked_at = NOW(), updated_at = NOW()
       WHERE target.id = $1
         AND attempts < $2
         AND (
           (status IN ('pending', 'failed') AND available_at <= NOW())
           OR (status = 'sending' AND locked_at < NOW() - $3::interval)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM whatsapp_outbox prior
           JOIN messages prior_message ON prior_message.id = prior.message_id
           JOIN messages target_message ON target_message.id = target.message_id
           WHERE prior.conversation_id = target.conversation_id
             AND prior.id <> target.id
             AND prior_message.sequence_id < target_message.sequence_id
             AND (
               prior.status IN ('pending', 'sending')
               OR (prior.status = 'failed' AND prior.attempts < $2)
             )
         )
       RETURNING id, org_id, conversation_id, message_id, phone, reply_jid,
                 text, kind, idempotency_key, required_mode,
                 required_version, attempts, created_at`,
      [outboxId, MAX_DELIVERY_ATTEMPTS, DELIVERY_LEASE_INTERVAL]
    );
    const item = claimed.rows[0];
    if (!item) {
      const result = await currentDeliveryResult(client, outboxId);
      await client.query('COMMIT');
      return { action: 'return', result };
    }

    const state = conversation.rows[0];
    const stateMismatch =
      !state ||
      state.status !== 'active' ||
      state.current_whatsapp_jid !== item.reply_jid ||
      (item.required_mode !== null && state.reply_mode !== item.required_mode) ||
      (item.required_version !== null &&
        state.mode_version !== item.required_version) ||
      (state.opted_out && item.kind !== 'control') ||
      !state.recent_customer ||
      (item.kind === 'follow_up' && state.customer_after_outbox);
    if (stateMismatch) {
      await markCancelled(client, item);
      await client.query('COMMIT');
      return { action: 'return', result: { status: 'cancelled' } };
    }

    if (whatsappBridge.getStatus(item.org_id).status !== 'connected') {
      await client.query(
        `UPDATE whatsapp_outbox
         SET status = 'pending', attempts = GREATEST(0, attempts - 1),
             locked_at = NULL, available_at = NOW() + INTERVAL '2 seconds',
             updated_at = NOW()
         WHERE id = $1`,
        [item.id]
      );
      await client.query(
        `UPDATE messages SET delivery_status = 'pending' WHERE id = $1`,
        [item.message_id]
      );
      await client.query('COMMIT');
      return { action: 'return', result: { status: 'pending' } };
    }

    await client.query(
      `UPDATE messages SET delivery_status = 'sending' WHERE id = $1`,
      [item.message_id]
    );
    await client.query('COMMIT');
    return { action: 'send', item };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeSentOutboxItem(
  item: ClaimedOutboxRow,
  providerMessageId: string
): Promise<WhatsAppDeliveryResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockConversation(client, item);
    const updated = await client.query<{ message_id: string }>(
      `UPDATE whatsapp_outbox
       SET status = 'sent', provider_message_id = $3, sent_at = NOW(),
           locked_at = NULL, last_error_code = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'sending' AND attempts = $2
       RETURNING message_id`,
      [item.id, item.attempts, providerMessageId]
    );
    if (updated.rows[0]) {
      await client.query(
        `UPDATE messages
         SET delivery_status = 'sent', provider_message_id = $2
         WHERE id = $1`,
        [updated.rows[0].message_id, providerMessageId]
      );
    }
    const result = await currentDeliveryResult(client, item.id);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function revalidateClaimedWhatsAppOutboxItem(
  item: ClaimedOutboxRow
): Promise<OutboxClaim> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stateResult = await client.query<DeliveryPolicyState & {
      outbox_status: WhatsAppDeliveryStatus;
      attempts: number;
    }>(
      `SELECT c.status::text AS status, c.reply_mode, c.mode_version,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
              l.metadata->>'whatsappJid' AS current_whatsapp_jid,
              o.status AS outbox_status, o.attempts,
              EXISTS (
                SELECT 1 FROM messages recent
                WHERE recent.conversation_id = c.id
                  AND recent.sender_type = 'customer'
                  AND recent.created_at >= NOW() - INTERVAL '24 hours'
              ) AS recent_customer,
              EXISTS (
                SELECT 1 FROM messages newer
                WHERE newer.conversation_id = c.id
                  AND newer.sender_type = 'customer'
                  AND newer.created_at > $4::timestamptz
              ) AS customer_after_outbox
       FROM whatsapp_outbox o
       JOIN conversations c ON c.id = o.conversation_id AND c.org_id = o.org_id
       LEFT JOIN leads l ON l.id = c.lead_id
       WHERE o.id = $1 AND c.id = $2 AND c.org_id = $3
       FOR UPDATE OF c, o`,
      [item.id, item.conversation_id, item.org_id, item.created_at]
    );
    const state = stateResult.rows[0];
    const stateMismatch =
      !state ||
      state.outbox_status !== 'sending' ||
      state.attempts !== item.attempts ||
      state.status !== 'active' ||
      state.current_whatsapp_jid !== item.reply_jid ||
      (item.required_mode !== null && state.reply_mode !== item.required_mode) ||
      (item.required_version !== null &&
        state.mode_version !== item.required_version) ||
      (state.opted_out && item.kind !== 'control') ||
      !state.recent_customer ||
      (item.kind === 'follow_up' && state.customer_after_outbox);
    if (stateMismatch && state?.outbox_status === 'sending') {
      await markCancelled(client, item);
    }
    if (stateMismatch) {
      const result = await currentDeliveryResult(client, item.id);
      await client.query('COMMIT');
      return { action: 'return', result };
    }
    await client.query('COMMIT');
    return { action: 'send', item };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeFailedOutboxItem(
  item: ClaimedOutboxRow,
  error: unknown
): Promise<WhatsAppDeliveryResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockConversation(client, item);
    const retrySeconds = Math.min(60, 2 ** Math.min(item.attempts, 5));
    const outcomeUnknown =
      error instanceof Error && error.name === 'WhatsAppSendTimeoutError';
    const updated = await client.query<{ message_id: string }>(
      `UPDATE whatsapp_outbox
       SET status = 'failed', locked_at = NULL, last_error_code = $3,
           attempts = CASE WHEN $5 THEN $6 ELSE attempts END,
           available_at = NOW() + ($4 * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE id = $1 AND status = 'sending' AND attempts = $2
       RETURNING message_id`,
      [
        item.id,
        item.attempts,
        outcomeUnknown ? 'DeliveryOutcomeUnknown' : safeDeliveryErrorCode(error),
        retrySeconds,
        outcomeUnknown,
        MAX_DELIVERY_ATTEMPTS,
      ]
    );
    if (updated.rows[0]) {
      await client.query(
        `UPDATE messages SET delivery_status = 'failed' WHERE id = $1`,
        [updated.rows[0].message_id]
      );
    }
    const result = await currentDeliveryResult(client, item.id);
    await client.query('COMMIT');
    return result;
  } catch (finalizeError) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw finalizeError;
  } finally {
    client.release();
  }
}

export function startWhatsAppOutboxWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void drainWhatsAppOutbox().catch(logDrainFailure);
  }, DELIVERY_INTERVAL_MS);
  workerTimer.unref();
  void drainWhatsAppOutbox().catch(logDrainFailure);
}

export function isWhatsAppOutboxWorkerRunning(): boolean {
  return workerTimer !== undefined;
}

export async function stopWhatsAppOutboxWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = undefined;
  await drainPromise;
}

export function drainWhatsAppOutbox(): Promise<void> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    const exhausted = await pool.query<{ id: string }>(
      `SELECT id
       FROM whatsapp_outbox
       WHERE attempts >= $1
         AND (
           status = 'pending'
           OR (
             status = 'sending'
             AND locked_at < NOW() - $2::interval
           )
         )
       ORDER BY created_at ASC
       LIMIT $3`,
      [MAX_DELIVERY_ATTEMPTS, DELIVERY_LEASE_INTERVAL, DELIVERY_BATCH_SIZE]
    );
    await Promise.all(
      exhausted.rows.map(row =>
        deliverWhatsAppOutboxItem(row.id).catch(error => {
          logger.error('WhatsApp exhausted outbox recovery failed', {
            outboxId: row.id,
            code: safeDeliveryErrorCode(error),
          });
        })
      )
    );

    const due = await pool.query<{ id: string }>(
      `SELECT candidate.id
       FROM whatsapp_outbox candidate
       JOIN messages candidate_message ON candidate_message.id = candidate.message_id
       WHERE candidate.attempts < $1
         AND (
           (candidate.status IN ('pending', 'failed')
             AND candidate.available_at <= NOW())
           OR (
             candidate.status = 'sending'
             AND candidate.locked_at < NOW() - $2::interval
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM whatsapp_outbox prior
           JOIN messages prior_message ON prior_message.id = prior.message_id
           WHERE prior.conversation_id = candidate.conversation_id
             AND prior.id <> candidate.id
             AND prior_message.sequence_id < candidate_message.sequence_id
             AND (
               prior.status IN ('pending', 'sending')
               OR (prior.status = 'failed' AND prior.attempts < $1)
             )
         )
       ORDER BY candidate.available_at ASC, candidate_message.sequence_id ASC
       LIMIT $3`,
      [MAX_DELIVERY_ATTEMPTS, DELIVERY_LEASE_INTERVAL, DELIVERY_BATCH_SIZE]
    );
    await Promise.all(
      due.rows.map(row =>
        deliverWhatsAppOutboxItem(row.id).catch(error => {
          logger.error('WhatsApp outbox worker item failed', {
            outboxId: row.id,
            code: safeDeliveryErrorCode(error),
          });
        })
      )
    );
  })().finally(() => {
    drainPromise = undefined;
  });
  return drainPromise;
}

async function lockConversation(
  client: PoolClient,
  item: Pick<ClaimedOutboxRow, 'conversation_id' | 'org_id'>
): Promise<void> {
  await client.query(
    `SELECT id
     FROM conversations
     WHERE id = $1 AND org_id = $2
     FOR UPDATE`,
    [item.conversation_id, item.org_id]
  );
}

async function currentDeliveryResult(
  client: PoolClient,
  outboxId: string
): Promise<WhatsAppDeliveryResult> {
  const current = await client.query<{
    status: WhatsAppDeliveryStatus;
    provider_message_id: string | null;
  }>(
    `SELECT status, provider_message_id
     FROM whatsapp_outbox
     WHERE id = $1`,
    [outboxId]
  );
  return {
    status: current.rows[0]?.status ?? 'cancelled',
    messageId: current.rows[0]?.provider_message_id ?? undefined,
  };
}

async function markTerminalFailure(
  client: PoolClient,
  item: ClaimedOutboxRow
): Promise<void> {
  const updated = await client.query<{ message_id: string }>(
    `UPDATE whatsapp_outbox
     SET status = 'failed', locked_at = NULL,
         last_error_code = 'DeliveryAttemptsExhausted', updated_at = NOW()
     WHERE id = $1
       AND attempts >= $2
       AND (
         status = 'pending'
         OR (
           status = 'sending'
           AND locked_at < NOW() - $3::interval
         )
       )
     RETURNING message_id`,
    [item.id, MAX_DELIVERY_ATTEMPTS, DELIVERY_LEASE_INTERVAL]
  );
  if (updated.rows[0]) {
    await client.query(
      `UPDATE messages SET delivery_status = 'failed' WHERE id = $1`,
      [updated.rows[0].message_id]
    );
  }
}

async function markCancelled(
  client: PoolClient,
  item: ClaimedOutboxRow
): Promise<void> {
  await client.query(
    `UPDATE whatsapp_outbox
     SET status = 'cancelled', locked_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [item.id]
  );
  await client.query(
    `UPDATE messages SET delivery_status = 'cancelled' WHERE id = $1`,
    [item.message_id]
  );
}

function boundedSend(operation: Promise<string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('WhatsApp send timed out');
      error.name = 'WhatsAppSendTimeoutError';
      reject(error);
    }, SEND_TIMEOUT_MS);
    timer.unref();
    operation.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function safeDeliveryErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_ -]{1,80}$/.test(error.name)) {
    return error.name;
  }
  return 'WhatsAppDeliveryError';
}

function logDrainFailure(error: unknown): void {
  logger.error('WhatsApp outbox drain failed', {
    code: safeDeliveryErrorCode(error),
  });
}
