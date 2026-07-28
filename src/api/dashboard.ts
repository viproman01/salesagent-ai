import { Router } from 'express';
import { requireAuth, type JwtPayload } from './auth';
import pool from '../db';

export const dashboardRouter = Router();

async function sendDashboard(req: import('express').Request, res: import('express').Response, requestedOrgId?: string): Promise<void> {
  const user = (req as typeof req & { user: JwtPayload }).user;
  const orgId = requestedOrgId ?? user.orgId;

  if (user.orgId !== orgId && user.role !== 'superadmin') {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  // Параллельно запрашиваем все метрики
  const [
    totalConvResult,
    leadsResult,
    conversionResult,
    avgResponseResult,
    funnelResult,
    trendResult,
    subscriptionResult,
  ] = await Promise.all([
    // Всего разговоров за 30 дней
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM conversations
       WHERE org_id = $1 AND created_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)`,
      [orgId]
    ),
    // Всего лидов
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM leads WHERE org_id = $1`,
      [orgId]
    ),
    // Конверсия (closed_won / total_leads * 100)
    pool.query<{ total: string; won: string }>(
      `SELECT
         COUNT(*) AS total,
         SUM(stage = 'closed_won') AS won
       FROM leads WHERE org_id = $1`,
      [orgId]
    ),
    // Среднее время ответа (мс)
    pool.query<{ avg_latency: string }>(
      `SELECT AVG(m.latency_ms) AS avg_latency
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.org_id = $1 AND m.role = 'assistant' AND m.latency_ms IS NOT NULL
         AND m.created_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)`,
      [orgId]
    ),
    // Воронка по этапам
    pool.query<{ stage: string; count: string }>(
      `SELECT stage, COUNT(*) AS count
       FROM leads WHERE org_id = $1
       GROUP BY stage ORDER BY COUNT(*) DESC`,
      [orgId]
    ),
    // Тренд за 30 дней (разговоры по дням)
    pool.query<{ date: string; conversations: string; leads: string }>(
      `SELECT
         DATE(created_at) AS date,
         COUNT(*) AS conversations
       FROM conversations
       WHERE org_id = $1 AND created_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [orgId]
    ),
    // Подписка
    pool.query<{ plan: string; messages_used: number; messages_limit: number; minutes_used: number; minutes_limit: number }>(
      `SELECT plan, messages_used, messages_limit, minutes_used, minutes_limit
       FROM subscriptions WHERE org_id = $1`,
      [orgId]
    ),
  ]);

  const totalLeads = parseInt(conversionResult.rows[0]?.total ?? '0');
  const wonLeads   = parseInt(conversionResult.rows[0]?.won ?? '0');
  const conversion = totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100 * 10) / 10 : 0;

  res.json({
    metrics: {
      totalConversations: parseInt(totalConvResult.rows[0]?.count ?? '0'),
      totalLeads:         parseInt(leadsResult.rows[0]?.count ?? '0'),
      conversionRate:     conversion,
      avgResponseTimeMs:  Math.round(parseFloat(avgResponseResult.rows[0]?.avg_latency ?? '0')),
    },
    funnel:       funnelResult.rows,
    trend:        trendResult.rows,
    subscription: subscriptionResult.rows[0] ?? null,
  });
}

// Preferred endpoint: organization comes from the authenticated session.
dashboardRouter.get('/', requireAuth, async (req, res): Promise<void> => {
  await sendDashboard(req, res);
});

// Compatibility endpoint for old admin bundles.
dashboardRouter.get('/:orgId', requireAuth, async (req, res): Promise<void> => {
  const value = req.params['orgId'];
  const orgId = Array.isArray(value) ? value[0] : value;
  await sendDashboard(req, res, orgId);
});
