import { Queue, Worker } from 'bullmq';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getRedisConnection } from '../utils/redis';
import pool from '../db';

const IS_MEMORY = config.REDIS_URL === 'memory';

// Очередь для агрегации метрик
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metricsQueue: Queue | null = IS_MEMORY ? null : new Queue('metrics', {
  connection: getRedisConnection(),
  defaultJobOptions: { removeOnComplete: 10, removeOnFail: 5 },
});

/**
 * Worker ежедневной агрегации метрик
 */
export const metricsWorker: Worker | { run: () => Promise<void>; close: () => Promise<void> } = IS_MEMORY
  ? { run: async () => {}, close: async () => {} }
  : new Worker(
      'metrics',
      async (job) => {
        const { orgId, date } = job.data as { orgId: string; date: string };
        await aggregateDailyMetrics(orgId, date);
      },
      { connection: getRedisConnection() }
    );

/**
 * Агрегация метрик за указанную дату
 * Запускается ежедневно в 00:05 UTC через cron в BullMQ
 */
export async function aggregateDailyMetrics(orgId: string, date: string): Promise<void> {
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);

  const [convMetrics, leadMetrics, responseMetrics] = await Promise.all([
    // Метрики разговоров
    pool.query<{
      total: string; voice: string; whatsapp: string; telegram: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE channel = 'voice')::text AS voice,
         COUNT(*) FILTER (WHERE channel = 'whatsapp')::text AS whatsapp,
         COUNT(*) FILTER (WHERE channel = 'telegram')::text AS telegram
       FROM conversations
       WHERE org_id = $1
         AND created_at >= $2::date
         AND created_at < $3::date`,
      [orgId, date, nextDay.toISOString().split('T')[0]]
    ),
    // Метрики лидов
    pool.query<{ created: string; converted: string }>(
      `SELECT
         COUNT(*)::text AS created,
         COUNT(*) FILTER (WHERE stage = 'closed_won')::text AS converted
       FROM leads
       WHERE org_id = $1
         AND created_at >= $2::date
         AND created_at < $3::date`,
      [orgId, date, nextDay.toISOString().split('T')[0]]
    ),
    // Среднее время ответа
    pool.query<{ avg_latency: string }>(
      `SELECT AVG(m.latency_ms)::text AS avg_latency
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.org_id = $1 AND m.role = 'assistant'
         AND m.created_at >= $2::date
         AND m.created_at < $3::date`,
      [orgId, date, nextDay.toISOString().split('T')[0]]
    ),
  ]);

  const metrics = {
    total_conversations:           parseInt(convMetrics.rows[0]?.total ?? '0'),
    voice_conversations:           parseInt(convMetrics.rows[0]?.voice ?? '0'),
    whatsapp_conversations:        parseInt(convMetrics.rows[0]?.whatsapp ?? '0'),
    telegram_conversations:        parseInt(convMetrics.rows[0]?.telegram ?? '0'),
    leads_created:                 parseInt(leadMetrics.rows[0]?.created ?? '0'),
    leads_converted:               parseInt(leadMetrics.rows[0]?.converted ?? '0'),
    avg_response_time_ms:          Math.round(parseFloat(responseMetrics.rows[0]?.avg_latency ?? '0')),
  };

  // Upsert метрики за день
  await pool.query(
    `INSERT INTO daily_metrics
       (org_id, date, total_conversations, voice_conversations, whatsapp_conversations,
        telegram_conversations, leads_created, leads_converted, avg_response_time_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (org_id, date) DO UPDATE SET
       total_conversations     = EXCLUDED.total_conversations,
       voice_conversations     = EXCLUDED.voice_conversations,
       whatsapp_conversations  = EXCLUDED.whatsapp_conversations,
       telegram_conversations  = EXCLUDED.telegram_conversations,
       leads_created           = EXCLUDED.leads_created,
       leads_converted         = EXCLUDED.leads_converted,
       avg_response_time_ms    = EXCLUDED.avg_response_time_ms,
       updated_at              = NOW()`,
    [
      orgId, date,
      metrics.total_conversations,
      metrics.voice_conversations,
      metrics.whatsapp_conversations,
      metrics.telegram_conversations,
      metrics.leads_created,
      metrics.leads_converted,
      metrics.avg_response_time_ms,
    ]
  );

  logger.info('Daily metrics aggregated', { orgId, date, ...metrics });
}

/**
 * Запланировать агрегацию метрик для всех организаций
 */
export async function scheduleAllOrgMetrics(): Promise<void> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const date = yesterday.toISOString().split('T')[0]!;

  if (!metricsQueue) return; // in-memory mode
  const orgs = await pool.query<{ id: string }>('SELECT id FROM organizations');
  for (const org of orgs.rows) {
    await metricsQueue.add('daily', { orgId: org.id, date });
  }
}
