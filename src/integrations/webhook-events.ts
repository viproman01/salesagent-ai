import { randomUUID } from 'crypto';
import pool from '../db';

export async function claimWebhookEvent(provider: string, orgId: string, eventId: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO webhook_events (id, org_id, provider, event_id)
     VALUES ($1,$2,$3,$4)
     ON DUPLICATE KEY UPDATE event_id = event_id`,
    [randomUUID(), orgId, provider, eventId]
  );
  return result.affectedRows === 1;
}

export async function completeWebhookEvent(provider: string, eventId: string): Promise<void> {
  await pool.query(
    `UPDATE webhook_events
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP, error_message = NULL
     WHERE provider = $1 AND event_id = $2`,
    [provider, eventId]
  );
}

export async function failWebhookEvent(provider: string, eventId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE webhook_events
     SET status = 'failed', error_message = $1
     WHERE provider = $2 AND event_id = $3`,
    [message.slice(0, 500), provider, eventId]
  );
}
