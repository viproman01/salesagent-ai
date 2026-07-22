import pool from '../db';

export async function claimWhatsAppMessage(
  orgId: string,
  messageId: string
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO whatsapp_inbound_receipts (org_id, message_id)
     VALUES ($1, $2)
     ON CONFLICT (org_id, message_id) DO UPDATE
       SET status = 'processing',
           attempts = whatsapp_inbound_receipts.attempts + 1,
           updated_at = NOW()
       WHERE whatsapp_inbound_receipts.status = 'failed'
          OR (
            whatsapp_inbound_receipts.status = 'processing'
            AND whatsapp_inbound_receipts.updated_at < NOW() - INTERVAL '5 minutes'
          )
     RETURNING id`,
    [orgId, messageId]
  );
  return result.rows.length > 0;
}

export async function completeWhatsAppMessage(
  orgId: string,
  messageId: string
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_inbound_receipts
     SET status = 'processed', processed_at = NOW(), updated_at = NOW()
     WHERE org_id = $1 AND message_id = $2`,
    [orgId, messageId]
  );
}

export async function failWhatsAppMessage(
  orgId: string,
  messageId: string
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_inbound_receipts
     SET status = 'failed', updated_at = NOW()
     WHERE org_id = $1 AND message_id = $2`,
    [orgId, messageId]
  );
}
