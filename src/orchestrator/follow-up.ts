import { Queue, Worker } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getRedisConnection } from '../utils/redis';
import { sendWhatsAppMessage } from '../channels/whatsapp';
import { sendTelegramMessage } from '../channels/telegram';
import pool from '../db';

interface FollowUpJob {
  orgId:          string;
  leadId:         string;
  conversationId: string;
  channel:        string;
  phone:          string;
  message:        string;
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

        // Проверяем — вдруг лид уже ответил
        const recentMsg = await pool.query(
          `SELECT id FROM messages
           WHERE conversation_id = $1 AND role = 'user'
             AND created_at > NOW() - INTERVAL '1 hour'
           LIMIT 1`,
          [conversationId]
        );
        if (recentMsg.rows.length > 0) {
          logger.info('Follow-up skipped: customer responded recently', { leadId });
          return;
        }

        // Отправляем follow-up
        if (channel === 'whatsapp') {
          await sendWhatsAppMessage(phone, message);
        } else if (channel === 'telegram') {
          await sendTelegramMessage(phone, message);
        }

        // Сохраняем в БД
        await pool.query(
          `INSERT INTO messages (conversation_id, role, content)
           VALUES ($1, 'assistant', $2)`,
          [conversationId, `[Follow-up] ${message}`]
        );
      },
      {
        connection: getRedisConnection(),
        concurrency: 5,
      }
    );

if (!IS_MEMORY) {
  (followUpWorker as Worker<FollowUpJob>).on('failed', (job, err) => {
    logger.error('Follow-up job failed', { jobId: job?.id, error: err.message });
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
  await followUpQueue.add('send', data, { delay: delayMs });
  logger.debug('Follow-up scheduled', {
    leadId: data.leadId,
    delayMinutes: Math.round(delayMs / 60000),
  });
}
