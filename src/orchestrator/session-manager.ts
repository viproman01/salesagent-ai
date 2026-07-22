import type { PoolClient } from 'pg';
import pool from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getAutomaticAgentResponse } from '../chat/automatic-response';
import { getOrCreateLead } from '../crm/adapter';
import { sendTelegramMessage } from '../channels/telegram';
import { scheduleClassification } from './classifier';
import {
  classifyWhatsAppControlCommand,
  ensureAiDisclosure,
  WHATSAPP_CONTROL_REPLIES,
  WHATSAPP_RATE_LIMIT_REPLY,
  type WhatsAppControlCommand,
} from '../whatsapp/policy';
import { checkWhatsAppInboundRateLimit } from '../whatsapp/inbound-rate-limit';
import {
  deliverWhatsAppOutboxItem,
  enqueueWhatsAppReply,
} from '../whatsapp/outbox';

export interface IncomingMessage {
  channel: 'whatsapp' | 'telegram' | 'voice';
  phone: string;
  text: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
  orgId?: string;
}

type AgentRow = Readonly<{
  id: string;
  system_prompt: string;
  name: string;
}>;

type WhatsAppPreparedTurn = Readonly<{
  action: 'generate' | 'suppressed' | 'deliver_existing' | 'control';
  modeVersion: number;
  firstAiReply: boolean;
  outboxId?: string;
  inboundCreated: boolean;
  controlCommand?: WhatsAppControlCommand;
}>;

/**
 * Центральный обработчик входящих сообщений. WhatsApp проходит через
 * durable inbox/outbox, STOP/handoff policy и per-contact rate limit до LLM.
 */
export async function processIncomingMessage(msg: IncomingMessage): Promise<void> {
  const startTime = Date.now();
  const orgId = msg.orgId ?? (await resolveOrg(msg.channel, msg.phone));
  if (!orgId) {
    logger.warn('Cannot resolve organization', {
      channel: msg.channel,
    });
    return;
  }

  const { id: leadId, isNew } = await getOrCreateLead(
    orgId,
    msg.phone,
    msg.channel
  );
  if (isNew) logger.info('New lead created', { orgId, leadId });

  const whatsappJid = stringMetadata(msg.metadata, 'whatsappJid');
  const whatsappPushName = stringMetadata(msg.metadata, 'whatsappPushName');
  if (msg.channel === 'whatsapp') {
    if (!msg.externalId || !whatsappJid) {
      logger.warn('WhatsApp inbound message missing verified identity', {
        orgId,
        hasExternalId: Boolean(msg.externalId),
        hasReplyJid: Boolean(whatsappJid),
      });
      return;
    }
    await updateWhatsAppIdentity(
      orgId,
      leadId,
      whatsappJid,
      whatsappPushName
    );
  }

  const conversationId = await getOrCreateConversation(
    orgId,
    leadId,
    msg.channel
  );

  if (msg.channel === 'whatsapp') {
    await processWhatsAppTurn({
      orgId,
      leadId,
      conversationId,
      phone: msg.phone,
      text: msg.text,
      externalId: msg.externalId!,
      replyJid: whatsappJid!,
      startTime,
    });
    return;
  }

  await processLegacyTurn({
    orgId,
    leadId,
    conversationId,
    msg,
    startTime,
  });
}

async function processWhatsAppTurn(input: Readonly<{
  orgId: string;
  leadId: string;
  conversationId: string;
  phone: string;
  text: string;
  externalId: string;
  replyJid: string;
  startTime: number;
}>): Promise<void> {
  const prepared = await persistWhatsAppInbound(input);
  if (prepared.outboxId) {
    await deliverWhatsAppOutboxItem(prepared.outboxId);
    return;
  }
  if (prepared.action === 'suppressed') return;

  if (prepared.inboundCreated) {
    const rate = await checkWhatsAppInboundRateLimit(input.orgId, input.phone);
    if (!rate.allowed) {
      // STOP state is applied transactionally before this external limiter,
      // but no control acknowledgement is emitted while throttled. START and
      // human handoff are applied only after an allowed decision below.
      if (rate.notify && prepared.action === 'generate') {
        const outboxId = await enqueuePolicyReply(input, {
          text: WHATSAPP_RATE_LIMIT_REPLY,
          kind: 'rate_limit',
          idempotencyKey: `rate:${input.externalId}`,
          requiredMode: 'ai',
          requiredVersion: prepared.modeVersion,
        });
        if (outboxId) await deliverWhatsAppOutboxItem(outboxId);
      }
      logger.info('WhatsApp inbound rate limited', {
        orgId: input.orgId,
        conversationId: input.conversationId,
      });
      return;
    }
  }

  if (prepared.action === 'control') {
    if (!prepared.controlCommand) {
      throw new Error('WhatsApp control command unavailable');
    }
    const outboxId = await applyAllowedControlCommand(
      input,
      prepared.controlCommand
    );
    if (outboxId) await deliverWhatsAppOutboxItem(outboxId);
    return;
  }

  const agent = await findActiveAgent(input.orgId, 'whatsapp');
  if (!agent) {
    const outboxId = await handOffUnavailableConversation(
      input,
      prepared.modeVersion
    );
    if (outboxId) await deliverWhatsAppOutboxItem(outboxId);
    logger.warn('No active WhatsApp agent; conversation handed to operator', {
      orgId: input.orgId,
      conversationId: input.conversationId,
    });
    return;
  }

  let response: Awaited<ReturnType<typeof getAutomaticAgentResponse>>;
  try {
    response = await getAutomaticAgentResponse(
      agent.system_prompt,
      input.text,
      {
        orgId: input.orgId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        phone: input.phone,
        whatsappJid: input.replyJid,
      }
    );
  } catch (error) {
    logger.warn('WhatsApp automatic response unavailable', {
      orgId: input.orgId,
      conversationId: input.conversationId,
      code: error instanceof Error ? error.name : 'UnknownError',
    });
    const outboxId = await handOffUnavailableConversation(
      input,
      prepared.modeVersion
    );
    if (outboxId) await deliverWhatsAppOutboxItem(outboxId);
    return;
  }
  const text = ensureAiDisclosure(response.text, prepared.firstAiReply);
  const outboxId = await enqueueGeneratedReply(input, {
    modeVersion: prepared.modeVersion,
    text,
    tokensInput: response.tokensInput,
    tokensOutput: response.tokensOutput,
    latencyMs: response.latencyMs,
  });
  if (!outboxId) {
    logger.info('WhatsApp AI reply suppressed after mode change', {
      orgId: input.orgId,
      conversationId: input.conversationId,
    });
    return;
  }

  const delivery = await deliverWhatsAppOutboxItem(outboxId);
  if (config.TEXT_CHAT_CLASSIFICATION_ENABLED) {
    scheduleClassification(
      input.conversationId,
      input.orgId,
      input.leadId
    ).catch(error => {
      logger.error('Classification scheduling failed', {
        error,
        conversationId: input.conversationId,
      });
    });
  }
  logger.info('WhatsApp message processed', {
    orgId: input.orgId,
    leadId: input.leadId,
    conversationId: input.conversationId,
    latencyMs: Date.now() - input.startTime,
    deliveryStatus: delivery.status,
  });
}

async function persistWhatsAppInbound(
  input: Readonly<{
    orgId: string;
    leadId: string;
    conversationId: string;
    phone: string;
    text: string;
    externalId: string;
    replyJid: string;
  }>
): Promise<WhatsAppPreparedTurn> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await lockConversationState(
      client,
      input.orgId,
      input.conversationId
    );
    if (!state) throw new Error('Conversation state unavailable');

    const inbound = await client.query<{ id: string }>(
      `INSERT INTO messages (
         conversation_id, role, content, sender_type, delivery_status,
         external_id, provider_message_id
       ) VALUES ($1, 'user', $2, 'customer', 'received', $3, $4)
       ON CONFLICT (conversation_id, external_id)
         WHERE external_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        input.conversationId,
        input.text,
        `wa-in:${input.externalId}`.slice(0, 255),
        input.externalId,
      ]
    );
    const inboundCreated = Boolean(inbound.rows[0]);
    if (inboundCreated) {
      await client.query(
        `UPDATE leads
         SET last_contact_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND org_id = $2`,
        [input.leadId, input.orgId]
      );
      await client.query(
        `UPDATE subscriptions
         SET messages_used = messages_used + 1, updated_at = NOW()
         WHERE org_id = $1`,
        [input.orgId]
      );
    }

    const existingOutbox = await client.query<{ id: string }>(
      `SELECT id FROM whatsapp_outbox
       WHERE org_id = $1
         AND idempotency_key = ANY($2::text[])
       ORDER BY created_at ASC
       LIMIT 1`,
      [
        input.orgId,
        [
          `control:${input.externalId}`,
          `rate:${input.externalId}`,
          `auto:${input.externalId}`,
          `unavailable:${input.externalId}`,
        ],
      ]
    );
    if (existingOutbox.rows[0]) {
      await client.query('COMMIT');
      return {
        action: 'deliver_existing',
        modeVersion: state.mode_version,
        firstAiReply: false,
        outboxId: existingOutbox.rows[0].id,
        inboundCreated,
      };
    }

    if (!inboundCreated) {
      await client.query('COMMIT');
      return {
        action: 'suppressed',
        modeVersion: state.mode_version,
        firstAiReply: false,
        inboundCreated: false,
      };
    }

    const command = classifyWhatsAppControlCommand(input.text);
    let modeVersion = state.mode_version;
    if (command === 'stop') {
      const updated = await applyControlCommand(
        client,
        input,
        'stop',
        state.opted_out
      );
      modeVersion = updated.modeVersion;
    }

    if (command) {
      await client.query('COMMIT');
      return {
        action: 'control',
        modeVersion,
        firstAiReply: false,
        inboundCreated: true,
        controlCommand: command,
      };
    }

    const firstAi = await client.query<{ first_ai: boolean }>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM messages
         WHERE conversation_id = $1 AND sender_type = 'ai'
       ) AS first_ai`,
      [input.conversationId]
    );
    await client.query('COMMIT');
    return {
      action:
        state.reply_mode === 'ai' && !state.opted_out
          ? 'generate'
          : 'suppressed',
      modeVersion: state.mode_version,
      firstAiReply: firstAi.rows[0]?.first_ai ?? true,
      inboundCreated: true,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function applyAllowedControlCommand(
  input: Readonly<{
    orgId: string;
    leadId: string;
    conversationId: string;
    phone: string;
    replyJid: string;
    externalId: string;
  }>,
  command: WhatsAppControlCommand
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await lockConversationState(
      client,
      input.orgId,
      input.conversationId
    );
    if (!state) {
      await client.query('COMMIT');
      return null;
    }

    let modeVersion = state.mode_version;
    const stopAlreadyApplied =
      command === 'stop' &&
      state.reply_mode === 'operator' &&
      state.opted_out;
    if (!stopAlreadyApplied) {
      const updated = await applyControlCommand(
        client,
        input,
        command,
        state.opted_out
      );
      modeVersion = updated.modeVersion;
    }

    const queued = await enqueueWhatsAppReply(client, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      phone: input.phone,
      replyJid: input.replyJid,
      text: WHATSAPP_CONTROL_REPLIES[command],
      senderType: 'ai',
      kind: 'control',
      idempotencyKey: `control:${input.externalId}`,
      requiredVersion: modeVersion,
    });
    await client.query('COMMIT');
    return queued.outboxId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function applyControlCommand(
  client: PoolClient,
  input: Readonly<{
    orgId: string;
    leadId: string;
    conversationId: string;
  }>,
  command: WhatsAppControlCommand,
  wasOptedOut: boolean
): Promise<Readonly<{
  modeVersion: number;
  replyMode: 'ai' | 'operator';
  optedOut: boolean;
}>> {
  const replyMode = command === 'start' ? 'ai' : 'operator';
  const metadata = command === 'stop'
    ? {
        whatsappOptedOut: true,
        whatsappHumanHandoff: false,
        whatsappStateUpdatedAt: new Date().toISOString(),
      }
    : command === 'start'
      ? {
          whatsappOptedOut: false,
          whatsappHumanHandoff: false,
          whatsappStateUpdatedAt: new Date().toISOString(),
        }
      : {
          whatsappHumanHandoff: true,
          whatsappStateUpdatedAt: new Date().toISOString(),
        };
  const conversation = await client.query<{ mode_version: number }>(
    `UPDATE conversations
     SET reply_mode = $1, mode_version = mode_version + 1,
         assigned_user_id = NULL, updated_at = NOW()
     WHERE id = $2 AND org_id = $3
     RETURNING mode_version`,
    [replyMode, input.conversationId, input.orgId]
  );
  await client.query(
    `UPDATE leads
     SET metadata = metadata || $1::jsonb, updated_at = NOW()
     WHERE id = $2 AND org_id = $3`,
    [JSON.stringify(metadata), input.leadId, input.orgId]
  );
  await cancelActiveWhatsAppOutbox(client, input.conversationId);
  return {
    modeVersion: conversation.rows[0]!.mode_version,
    replyMode,
    optedOut: command === 'stop' || (command === 'human' && wasOptedOut),
  };
}

async function enqueuePolicyReply(
  input: Readonly<{
    orgId: string;
    conversationId: string;
    phone: string;
    replyJid: string;
  }>,
  reply: Readonly<{
    text: string;
    kind: 'rate_limit';
    idempotencyKey: string;
    requiredMode: 'ai';
    requiredVersion: number;
  }>
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await lockConversationState(
      client,
      input.orgId,
      input.conversationId
    );
    if (
      !state ||
      state.reply_mode !== reply.requiredMode ||
      state.mode_version !== reply.requiredVersion ||
      state.opted_out
    ) {
      await client.query('COMMIT');
      return null;
    }
    const queued = await enqueueWhatsAppReply(client, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      phone: input.phone,
      replyJid: input.replyJid,
      text: reply.text,
      senderType: 'ai',
      kind: reply.kind,
      idempotencyKey: reply.idempotencyKey,
      requiredMode: reply.requiredMode,
      requiredVersion: reply.requiredVersion,
    });
    await client.query('COMMIT');
    return queued.outboxId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueGeneratedReply(
  input: Readonly<{
    orgId: string;
    conversationId: string;
    phone: string;
    replyJid: string;
    externalId: string;
  }>,
  reply: Readonly<{
    modeVersion: number;
    text: string;
    tokensInput: number;
    tokensOutput: number;
    latencyMs: number;
  }>
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await lockConversationState(
      client,
      input.orgId,
      input.conversationId
    );
    if (
      !state ||
      state.reply_mode !== 'ai' ||
      state.mode_version !== reply.modeVersion ||
      state.opted_out
    ) {
      await client.query('COMMIT');
      return null;
    }
    const queued = await enqueueWhatsAppReply(client, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      phone: input.phone,
      replyJid: input.replyJid,
      text: reply.text,
      senderType: 'ai',
      kind: 'ai',
      idempotencyKey: `auto:${input.externalId}`,
      requiredMode: 'ai',
      requiredVersion: reply.modeVersion,
      tokensInput: reply.tokensInput,
      tokensOutput: reply.tokensOutput,
      latencyMs: reply.latencyMs,
    });
    await client.query('COMMIT');
    return queued.outboxId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function handOffUnavailableConversation(
  input: Readonly<{
    orgId: string;
    leadId: string;
    conversationId: string;
    phone: string;
    replyJid: string;
    externalId: string;
  }>,
  expectedVersion: number
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const state = await lockConversationState(
      client,
      input.orgId,
      input.conversationId
    );
    if (
      !state ||
      state.reply_mode !== 'ai' ||
      state.mode_version !== expectedVersion ||
      state.opted_out
    ) {
      await client.query('COMMIT');
      return null;
    }
    const updated = await client.query<{ mode_version: number }>(
      `UPDATE conversations
       SET reply_mode = 'operator', mode_version = mode_version + 1,
           updated_at = NOW()
       WHERE id = $1 AND org_id = $2
       RETURNING mode_version`,
      [input.conversationId, input.orgId]
    );
    await client.query(
      `UPDATE leads
       SET metadata = metadata || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND org_id = $3`,
      [
        JSON.stringify({
          whatsappHumanHandoff: true,
          whatsappStateUpdatedAt: new Date().toISOString(),
        }),
        input.leadId,
        input.orgId,
      ]
    );
    await cancelActiveWhatsAppOutbox(client, input.conversationId);
    const queued = await enqueueWhatsAppReply(client, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      phone: input.phone,
      replyJid: input.replyJid,
      text:
        'Я AI-ассистент компании. Сейчас автоматический ответ недоступен, поэтому передаю переписку оператору.',
      senderType: 'ai',
      kind: 'control',
      idempotencyKey: `unavailable:${input.externalId}`,
      requiredVersion: updated.rows[0]!.mode_version,
    });
    await client.query('COMMIT');
    return queued.outboxId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cancelActiveWhatsAppOutbox(
  client: PoolClient,
  conversationId: string
): Promise<void> {
  const cancelled = await client.query<{ message_id: string }>(
    `UPDATE whatsapp_outbox
     SET status = 'cancelled', locked_at = NULL, updated_at = NOW()
     WHERE conversation_id = $1
       AND status IN ('pending', 'failed', 'sending')
     RETURNING message_id`,
    [conversationId]
  );
  if (cancelled.rows.length > 0) {
    await client.query(
      `UPDATE messages
       SET delivery_status = 'cancelled'
       WHERE id = ANY($1::uuid[])`,
      [cancelled.rows.map(row => row.message_id)]
    );
  }
}

async function lockConversationState(
  client: PoolClient,
  orgId: string,
  conversationId: string
): Promise<
  | Readonly<{
      reply_mode: 'ai' | 'operator';
      mode_version: number;
      opted_out: boolean;
    }>
  | undefined
> {
  const result = await client.query<{
    reply_mode: 'ai' | 'operator';
    mode_version: number;
    opted_out: boolean;
  }>(
    `SELECT c.reply_mode, c.mode_version,
            COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out
     FROM conversations c
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE c.id = $1 AND c.org_id = $2
     FOR UPDATE OF c`,
    [conversationId, orgId]
  );
  return result.rows[0];
}

async function processLegacyTurn(input: Readonly<{
  orgId: string;
  leadId: string;
  conversationId: string;
  msg: IncomingMessage;
  startTime: number;
}>): Promise<void> {
  const agent = await findActiveAgent(input.orgId, input.msg.channel);
  if (!agent) {
    logger.warn('No active agent for channel', {
      orgId: input.orgId,
      channel: input.msg.channel,
    });
    return;
  }
  const response = await getAutomaticAgentResponse(
    agent.system_prompt,
    input.msg.text,
    {
      orgId: input.orgId,
      leadId: input.leadId,
      conversationId: input.conversationId,
      phone: input.msg.phone,
    }
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
      [input.conversationId, input.msg.text, response.text]
    );
    await client.query(
      `UPDATE subscriptions
       SET messages_used = messages_used + 2, updated_at = NOW()
       WHERE org_id = $1`,
      [input.orgId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (input.msg.channel === 'telegram') {
    const chatId = stringMetadata(input.msg.metadata, 'telegramChatId') ??
      input.msg.phone;
    await sendTelegramMessage(chatId, response.text);
  }
  logger.info('Message processed', {
    orgId: input.orgId,
    leadId: input.leadId,
    conversationId: input.conversationId,
    channel: input.msg.channel,
    latencyMs: Date.now() - input.startTime,
  });
}

async function findActiveAgent(
  orgId: string,
  channel: string
): Promise<AgentRow | undefined> {
  const result = await pool.query<AgentRow>(
    `SELECT id, system_prompt, name
     FROM agents
     WHERE org_id = $1 AND is_active = true AND $2 = ANY(channels)
     ORDER BY created_at ASC
     LIMIT 1`,
    [orgId, channel]
  );
  return result.rows[0];
}

async function updateWhatsAppIdentity(
  orgId: string,
  leadId: string,
  whatsappJid: string,
  pushName?: string
): Promise<void> {
  await pool.query(
    `UPDATE leads
     SET metadata = metadata || jsonb_strip_nulls(
           jsonb_build_object(
             'whatsappJid', $1::text,
             'whatsappPushName', $2::text
           )
         ),
         name = COALESCE(name, NULLIF($2::text, '')),
         updated_at = NOW()
     WHERE id = $3 AND org_id = $4`,
    [whatsappJid, pushName ?? null, leadId, orgId]
  );
}

async function getOrCreateConversation(
  orgId: string,
  leadId: string,
  channel: string
): Promise<string> {
  const client = await pool.connect();
  const identity = `${orgId}:${leadId}:${channel}`;
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [identity]
    );
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM conversations
       WHERE org_id = $1 AND lead_id = $2 AND channel = $3::channel_type
         AND status = 'active'
         AND started_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      [orgId, leadId, channel]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return existing.rows[0].id;
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO conversations (
         org_id, lead_id, channel, status, reply_mode
       )
       SELECT $1, $2, $3::channel_type, 'active',
              CASE
                WHEN $3 = 'whatsapp' AND (
                  COALESCE(l.metadata->>'whatsappHumanHandoff' = 'true', false)
                  OR COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false)
                ) THEN 'operator'
                ELSE 'ai'
              END
       FROM leads l
       WHERE l.id = $2 AND l.org_id = $1
       RETURNING id`,
      [orgId, leadId, channel]
    );
    if (!created.rows[0]) throw new Error('Conversation lead unavailable');
    await client.query('COMMIT');
    return created.rows[0]!.id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function resolveOrg(
  _channel: string,
  _phone: string
): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM organizations LIMIT 1'
  );
  return result.rows[0]?.id ?? null;
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
