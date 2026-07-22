import { Queue, Worker, type Job } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getRedisConnection } from '../utils/redis';
import { sendTelegramMessage } from '../channels/telegram';
import pool from '../db';
import {
  deliverWhatsAppOutboxItem,
  enqueueWhatsAppReply,
} from '../whatsapp/outbox';

interface FollowUpJob {
  orgId:          string;
  leadId:         string;
  conversationId: string;
  channel:        string;
  phone:          string;
  message:        string;
  whatsappJid?:   string;
  baselineSequenceId?: string;
}

const IS_MEMORY = config.REDIS_URL === 'memory';

// Очередь для отложенных follow-up сообщений
export const followUpQueue: Queue<FollowUpJob> | null = IS_MEMORY ? null : new Queue<FollowUpJob>('follow-up', {
  connection: getRedisConnection(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail:     50,
    attempts:         3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});

// Worker для обработки follow-up заданий
export const followUpWorker: Worker<FollowUpJob> | { run: () => Promise<void>; close: () => Promise<void>; on: () => void } = IS_MEMORY
  ? { run: async () => {}, close: async () => {}, on: () => {} }
  : new Worker<FollowUpJob>(
      'follow-up',
      async (job) => {
        const { orgId, leadId, conversationId, channel, phone, message } = job.data;

        logger.info('Processing follow-up', { orgId, leadId, conversationId, channel });

        if (channel === 'whatsapp') {
          await processWhatsAppFollowUp(job);
          return;
        }

        const customerResponded = await hasCustomerRespondedSinceSchedule(
          orgId,
          leadId,
          conversationId,
          job.data.baselineSequenceId,
          new Date(job.timestamp)
        );
        if (customerResponded) {
          logger.info('Follow-up skipped: customer responded after scheduling', {
            orgId,
            leadId,
            conversationId,
          });
          return;
        }
        if (channel !== 'telegram') return;

        await sendTelegramMessage(phone, message);
        await pool.query(
          `INSERT INTO messages (conversation_id, role, content)
           VALUES ($1, 'assistant', $2)`,
          [conversationId, `[Follow-up] ${message}`]
        );
      },
      {
        connection: getRedisConnection(),
        concurrency: 5,
        // Startup is coordinated explicitly from src/index.ts.
        autorun: false,
      }
    );

if (!IS_MEMORY) {
  (followUpWorker as Worker<FollowUpJob>).on('failed', (job, err) => {
    logger.error('Follow-up job failed', {
      jobId: job?.id,
      code: err.name || 'FollowUpError',
    });
  });
}

/**
 * Запланировать follow-up сообщение с задержкой
 * @param delayMs — задержка в миллисекундах (по умолчанию 30 минут)
 */
export async function scheduleFollowUp(
  data: FollowUpJob,
  delayMs = 30 * 60 * 1000
): Promise<void> {
  if (!followUpQueue) {
    logger.debug('Follow-up skipped: running in memory mode', { leadId: data.leadId });
    return;
  }
  const baseline = await pool.query<{ sequence_id: string | null }>(
    `SELECT MAX(sequence_id)::text AS sequence_id
     FROM messages
     WHERE conversation_id = $1`,
    [data.conversationId]
  );
  await followUpQueue.add(
    'send',
    {
      ...data,
      baselineSequenceId: baseline.rows[0]?.sequence_id ?? '0',
    },
    { delay: delayMs }
  );
  logger.debug('Follow-up scheduled', {
    leadId: data.leadId,
    delayMinutes: Math.round(delayMs / 60000),
  });
}

async function processWhatsAppFollowUp(
  job: Job<FollowUpJob>
): Promise<void> {
  const { orgId, leadId, conversationId, message } = job.data;
  const client = await pool.connect();
  let outboxId: string | undefined;
  try {
    await client.query('BEGIN');
    const state = await client.query<{
      reply_mode: 'ai' | 'operator';
      mode_version: number;
      status: string;
      opted_out: boolean;
      phone: string | null;
      whatsapp_jid: string | null;
      customer_responded: boolean;
    }>(
      `SELECT c.reply_mode, c.mode_version, c.status::text AS status, l.phone,
              COALESCE(l.metadata->>'whatsappOptedOut' = 'true', false) AS opted_out,
              l.metadata->>'whatsappJid' AS whatsapp_jid,
              EXISTS (
                SELECT 1 FROM messages newer
                WHERE newer.conversation_id = c.id
                  AND newer.sender_type = 'customer'
                  AND (
                    ($4::bigint IS NOT NULL AND newer.sequence_id > $4::bigint)
                    OR ($4::bigint IS NULL AND newer.created_at > $5::timestamptz)
                  )
              ) AS customer_responded
       FROM conversations c
       JOIN leads l ON l.id = c.lead_id AND l.org_id = c.org_id
       WHERE c.id = $1 AND c.org_id = $2 AND l.id = $3
         AND c.channel = 'whatsapp'::channel_type
       FOR UPDATE OF c`,
      [
        conversationId,
        orgId,
        leadId,
        job.data.baselineSequenceId ?? null,
        new Date(job.timestamp),
      ]
    );
    const current = state.rows[0];
    if (
      !current ||
      current.status !== 'active' ||
      current.reply_mode !== 'ai' ||
      current.opted_out ||
      current.customer_responded ||
      !current.phone ||
      !current.whatsapp_jid
    ) {
      await client.query('COMMIT');
      logger.info('Follow-up skipped by current conversation policy', {
        orgId,
        leadId,
        conversationId,
      });
      return;
    }

    const queued = await enqueueWhatsAppReply(client, {
      orgId,
      conversationId,
      phone: current.phone,
      replyJid: current.whatsapp_jid,
      text: message,
      senderType: 'ai',
      kind: 'follow_up',
      idempotencyKey: `follow-up:${String(job.id ?? job.timestamp).slice(0, 220)}`,
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
  logger.info('WhatsApp follow-up processed', {
    orgId,
    leadId,
    conversationId,
    deliveryStatus: delivery.status,
  });
}

async function hasCustomerRespondedSinceSchedule(
  orgId: string,
  leadId: string,
  conversationId: string,
  baselineSequenceId: string | undefined,
  scheduledAt: Date
): Promise<boolean> {
  const result = await pool.query<{
    active: boolean;
    customer_responded: boolean;
  }>(
    `SELECT c.status = 'active'::conversation_status AS active,
            EXISTS (
       SELECT 1 FROM messages newer
       WHERE newer.conversation_id = c.id
         AND newer.sender_type = 'customer'
         AND (
           ($4::bigint IS NOT NULL AND newer.sequence_id > $4::bigint)
           OR ($4::bigint IS NULL AND newer.created_at > $5::timestamptz)
         )
     ) AS customer_responded
     FROM conversations c
     WHERE c.id = $1 AND c.org_id = $2 AND c.lead_id = $3`,
    [
      conversationId,
      orgId,
      leadId,
      baselineSequenceId ?? null,
      scheduledAt,
    ]
  );
  const state = result.rows[0];
  return !state || !state.active || state.customer_responded;
}
