import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import pool from '../db';
import {
  processWhatsAppBridgeMessage,
  whatsappBridge,
} from '../channels/whatsapp';
import { installAutomaticKnowledgeSearchForTesting } from '../chat/automatic-response';
import { installAutomaticTextReplyGeneratorForTesting } from '../chat/provider-chain';
import {
  deliverWhatsAppOutboxItem,
  drainWhatsAppOutbox,
  enqueueWhatsAppReply,
} from '../whatsapp/outbox';
import { getRedisConnection } from '../utils/redis';
import { checkWhatsAppInboundRateLimit } from '../whatsapp/inbound-rate-limit';

type CapturedSend = Readonly<{
  orgId: string;
  replyJid: string;
  text: string;
  messageId?: string;
}>;

function deferredSignal(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main(): Promise<void> {
  assertLocalE2EEnvironment();
  const orgId = randomUUID();
  const userId = randomUUID();
  const suffix = String(Date.now()).slice(-7);
  const phone = `7700${suffix}`;
  const replyJid = `${phone}@s.whatsapp.net`;
  const sent: CapturedSend[] = [];
  let modelCalls = 0;
  let heldSendText: string | undefined;
  let heldSendStarted = deferredSignal();
  let releaseHeldSend = deferredSignal();

  const restoreGenerator = installAutomaticTextReplyGeneratorForTesting(
    async request => {
      modelCalls += 1;
      assert.equal(request.messages.at(-1)?.role, 'user');
      return {
        text: modelCalls === 1
          ? 'Я Айгуль, менеджер магазина. Чем помочь?'
          : 'Автоматические ответы действительно снова работают.',
        tokensInput: 10,
        tokensOutput: 6,
        latencyMs: 5,
      };
    }
  );
  const restoreKnowledge = installAutomaticKnowledgeSearchForTesting(
    async () => []
  );

  const bridge = whatsappBridge as unknown as {
    getStatus(org: string): { status: 'connected' };
    sendMessage(
      org: string,
      targetPhone: string,
      text: string,
      jid: string,
      messageId?: string
    ): Promise<string>;
  };
  const originalGetStatus = bridge.getStatus.bind(whatsappBridge);
  const originalSendMessage = bridge.sendMessage.bind(whatsappBridge);
  bridge.getStatus = () => ({ status: 'connected' });
  bridge.sendMessage = async (org, _targetPhone, text, jid, messageId) => {
    if (text === heldSendText) {
      heldSendStarted.resolve();
      await releaseHeldSend.promise;
    }
    sent.push({ orgId: org, replyJid: jid, text, messageId });
    return messageId ?? randomUUID();
  };

  try {
    await pool.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'WhatsApp E2E', $2)`,
      [orgId, `whatsapp-e2e-${orgId}`]
    );
    await pool.query(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'not-used-in-e2e', 'E2E Operator', 'admin')`,
      [userId, orgId, `e2e-${orgId}@example.invalid`]
    );
    await pool.query(
      `INSERT INTO subscriptions (org_id, plan, messages_limit)
       VALUES ($1, 'trial', 1000)`,
      [orgId]
    );
    await pool.query(
      `INSERT INTO agents (org_id, name, system_prompt, channels, is_active)
       VALUES ($1, 'E2E AI', 'Отвечай кратко.', ARRAY['whatsapp'], true)`,
      [orgId]
    );

    const incoming = async (messageId: string, text: string): Promise<void> => {
      await processWhatsAppBridgeMessage(orgId, {
        messageId,
        phone,
        replyJid,
        text,
        pushName: 'E2E Customer',
      });
    };

    await incoming('e2e-normal-1', 'Здравствуйте');
    await incoming('e2e-normal-1', 'Здравствуйте');
    assert.equal(modelCalls, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /^Я AI-ассистент компании\./u);
    assert.equal(sent[0]!.replyJid, replyJid);

    await incoming('e2e-stop-2', '  СТОП!!! ');
    await incoming('e2e-suppressed-3', 'Вы ещё здесь?');
    assert.equal(modelCalls, 1);
    assert.equal(sent.length, 2);

    await incoming('e2e-start-4', 'СТАРТ');
    await incoming('e2e-normal-5', 'Проверка после старта');
    assert.equal(modelCalls, 2);
    assert.equal(sent.length, 4);

    await incoming('e2e-human-6', 'Позовите оператора');
    await incoming('e2e-suppressed-7', 'Жду человека');
    assert.equal(modelCalls, 2);
    assert.equal(sent.length, 5);

    const conversation = await pool.query<{
      id: string;
      mode_version: number;
      reply_mode: string;
      opted_out: boolean;
      handoff: boolean;
    }>(
      `SELECT c.id, c.mode_version, c.reply_mode,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
              COALESCE(l.metadata->>'whatsappHumanHandoff' = 'true', false) AS handoff
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE c.org_id = $1 AND c.channel = 'whatsapp'`,
      [orgId]
    );
    const state = conversation.rows[0]!;
    assert.equal(state.reply_mode, 'operator');
    assert.equal(state.opted_out, false);
    assert.equal(state.handoff, true);

    // A handoff is lead-level consent state: aging the current conversation
    // must not silently reactivate AI in the newly created 24-hour session.
    await pool.query(
      `UPDATE conversations
       SET started_at = NOW() - INTERVAL '25 hours'
       WHERE id = $1`,
      [state.id]
    );
    await incoming('e2e-handoff-new-8', 'Проверка нового диалога');
    assert.equal(modelCalls, 2);
    assert.equal(sent.length, 5);

    const inheritedConversation = await pool.query<{
      id: string;
      mode_version: number;
      reply_mode: string;
      opted_out: boolean;
      handoff: boolean;
    }>(
      `SELECT c.id, c.mode_version, c.reply_mode,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
              COALESCE(l.metadata->>'whatsappHumanHandoff' = 'true', false) AS handoff
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE c.org_id = $1 AND c.channel = 'whatsapp'
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [orgId]
    );
    const activeState = inheritedConversation.rows[0]!;
    assert.notEqual(activeState.id, state.id);
    assert.equal(activeState.reply_mode, 'operator');
    assert.equal(activeState.opted_out, false);
    assert.equal(activeState.handoff, true);

    const client = await pool.connect();
    let manualOutboxId: string;
    try {
      await client.query('BEGIN');
      const queued = await enqueueWhatsAppReply(client, {
        orgId,
        conversationId: activeState.id,
        phone,
        replyJid,
        text: 'Здравствуйте, подключился оператор.',
        senderType: 'operator',
        authorUserId: userId,
        kind: 'operator',
        idempotencyKey: `operator:${userId}:${randomUUID()}`,
        requiredMode: 'operator',
        requiredVersion: activeState.mode_version,
      });
      manualOutboxId = queued.outboxId;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const manualDelivery = await deliverWhatsAppOutboxItem(manualOutboxId!);
    assert.equal(manualDelivery.status, 'sent');
    assert.equal(sent.length, 6);

    // Behavioral consent race: once provider I/O has started it cannot be
    // physically recalled, but STOP must atomically cancel application state
    // and prevent any retry of an outcome-ambiguous send.
    const racingText = 'Ответ оператора, начатый до STOP.';
    heldSendText = racingText;
    heldSendStarted = deferredSignal();
    releaseHeldSend = deferredSignal();
    const raceClient = await pool.connect();
    let racingOutboxId: string;
    try {
      await raceClient.query('BEGIN');
      const queued = await enqueueWhatsAppReply(raceClient, {
        orgId,
        conversationId: activeState.id,
        phone,
        replyJid,
        text: racingText,
        senderType: 'operator',
        authorUserId: userId,
        kind: 'operator',
        idempotencyKey: `operator-race:${userId}:${randomUUID()}`,
        requiredMode: 'operator',
        requiredVersion: activeState.mode_version,
      });
      racingOutboxId = queued.outboxId;
      await raceClient.query('COMMIT');
    } catch (error) {
      await raceClient.query('ROLLBACK');
      throw error;
    } finally {
      raceClient.release();
    }
    const racingDeliveryPromise = deliverWhatsAppOutboxItem(racingOutboxId!);
    await heldSendStarted.promise;
    await incoming('e2e-stop-during-send-9', 'STOP');
    releaseHeldSend.resolve();
    const racingDelivery = await racingDeliveryPromise;
    assert.equal(racingDelivery.status, 'cancelled');
    await drainWhatsAppOutbox();
    assert.equal(sent.filter(item => item.text === racingText).length, 1);

    const racingState = await pool.query<{ status: string }>(
      'SELECT status FROM whatsapp_outbox WHERE id = $1',
      [racingOutboxId!]
    );
    assert.equal(racingState.rows[0]?.status, 'cancelled');

    // Exhaust the sender limiter. START must not clear an opt-out or enqueue an
    // acknowledgement, while STOP must still apply consent state immediately.
    for (
      let index = 0;
      index < config.WHATSAPP_INBOUND_RATE_MAX_MESSAGES;
      index += 1
    ) {
      await checkWhatsAppInboundRateLimit(orgId, phone);
    }
    const sendsBeforeThrottledControls = sent.length;
    await incoming('e2e-rate-start-10', 'START');
    assert.equal(sent.length, sendsBeforeThrottledControls);
    const afterDeniedStart = await pool.query<{
      reply_mode: string;
      opted_out: boolean;
    }>(
      `SELECT c.reply_mode,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE c.id = $1`,
      [activeState.id]
    );
    assert.equal(afterDeniedStart.rows[0]?.reply_mode, 'operator');
    assert.equal(afterDeniedStart.rows[0]?.opted_out, true);

    await pool.query(
      `UPDATE conversations
       SET reply_mode = 'ai', mode_version = mode_version + 1
       WHERE id = $1`,
      [activeState.id]
    );
    await pool.query(
      `UPDATE leads
       SET metadata = metadata || '{"whatsappOptedOut":false,"whatsappHumanHandoff":false}'::jsonb
       WHERE id = (SELECT lead_id FROM conversations WHERE id = $1)`,
      [activeState.id]
    );
    await incoming('e2e-rate-stop-11', 'STOP');
    assert.equal(sent.length, sendsBeforeThrottledControls);
    const afterThrottledStop = await pool.query<{
      reply_mode: string;
      opted_out: boolean;
      control_outbox: string;
    }>(
      `SELECT c.reply_mode,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
              (SELECT COUNT(*)::text FROM whatsapp_outbox o
               WHERE o.org_id = $2
                 AND o.idempotency_key = ANY($3::text[])) AS control_outbox
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id
       WHERE c.id = $1`,
      [
        activeState.id,
        orgId,
        ['control:e2e-rate-start-10', 'control:e2e-rate-stop-11'],
      ]
    );
    assert.equal(afterThrottledStop.rows[0]?.reply_mode, 'operator');
    assert.equal(afterThrottledStop.rows[0]?.opted_out, true);
    assert.equal(afterThrottledStop.rows[0]?.control_outbox, '0');

    const counts = await pool.query<{
      customer_messages: string;
      assistant_messages: string;
      sent_outbox: string;
      processed_receipts: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.org_id = $1 AND m.sender_type = 'customer') AS customer_messages,
         (SELECT COUNT(*)::text FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.org_id = $1 AND m.sender_type IN ('ai', 'operator')) AS assistant_messages,
         (SELECT COUNT(*)::text FROM whatsapp_outbox
          WHERE org_id = $1 AND status = 'sent') AS sent_outbox,
         (SELECT COUNT(*)::text FROM whatsapp_inbound_receipts
          WHERE org_id = $1 AND status = 'processed') AS processed_receipts`,
      [orgId]
    );
    assert.deepEqual(counts.rows[0], {
      customer_messages: '11',
      assistant_messages: '8',
      sent_outbox: '7',
      processed_receipts: '11',
    });

    const ordered = await pool.query<{
      sequence_id: string;
      sender_type: string;
    }>(
      `SELECT m.sequence_id::text, m.sender_type
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.org_id = $1
       ORDER BY m.sequence_id ASC`,
      [orgId]
    );
    const sequences = ordered.rows.map(row => Number(row.sequence_id));
    assert.ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]!));

    process.stdout.write(JSON.stringify({
      ok: true,
      modelCalls,
      outboundSends: sent.length,
      customerMessages: Number(counts.rows[0]!.customer_messages),
      assistantMessages: Number(counts.rows[0]!.assistant_messages),
      processedReceipts: Number(counts.rows[0]!.processed_receipts),
    }) + '\n');
  } finally {
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId])
      .catch(() => undefined);
    restoreGenerator();
    restoreKnowledge();
    bridge.getStatus = originalGetStatus;
    bridge.sendMessage = originalSendMessage;
    const redis = getRedisConnection();
    if (typeof redis.quit === 'function') await redis.quit().catch(() => undefined);
    await pool.end();
  }
}

function assertLocalE2EEnvironment(): void {
  if (process.env['WHATSAPP_E2E_CONFIRM_LOCAL'] !== '1') {
    throw new Error(
      'Set WHATSAPP_E2E_CONFIRM_LOCAL=1 to run the destructive local fixture'
    );
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('WhatsApp local E2E is disabled in production mode');
  }
  assertLocalServiceUrl('DATABASE_URL', process.env['DATABASE_URL']);
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl && redisUrl !== 'memory') {
    assertLocalServiceUrl('REDIS_URL', redisUrl);
  }
}

function assertLocalServiceUrl(name: string, value: string | undefined): void {
  if (!value) throw new Error(`${name} is required for local E2E`);
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!['localhost', '127.0.0.1', '::1', 'postgres', 'redis'].includes(hostname)) {
    throw new Error(`${name} must target a local Docker or loopback host`);
  }
}

main().catch(error => {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error
    ? error.message
        .replace(/(?:postgres(?:ql)?|redis):\/\/[^\s]+/giu, '[redacted-url]')
        .replace(/(?:csk|sk)-[A-Za-z0-9_-]+/gu, '[redacted-key]')
        .slice(0, 240)
    : 'Unknown error';
  process.stderr.write(
    `WhatsApp local E2E failed: ${error instanceof Error ? error.name : 'UnknownError'}` +
      `${code ? ` (${code})` : ''}: ${message}\n`
  );
  process.exitCode = 1;
});
