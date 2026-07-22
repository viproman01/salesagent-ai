import pool from '../db';
import { getAmoCRMClient } from './amocrm';
import { logger } from '../utils/logger';

/**
 * Унифицированный CRM-адаптер.
 * Обновляет лид в нашей БД + синхронизирует с внешней CRM (AmoCRM).
 */
export async function updateLeadStage(
  orgId: string,
  leadId: string,
  stage: string,
  notes?: string
): Promise<void> {
  // 1. Обновляем в нашей БД
  await pool.query(
    `UPDATE leads
     SET stage = $1::lead_stage, last_contact_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND org_id = $3`,
    [stage, leadId, orgId]
  );

  // 2. Синхронизируем с AmoCRM (если подключено)
  try {
    const crm = await getAmoCRMClient(orgId);
    if (!crm) return;

    // Получаем external_crm_id лида
    const leadResult = await pool.query<{ external_crm_id: string | null }>(
      'SELECT external_crm_id FROM leads WHERE id = $1',
      [leadId]
    );
    const lead = leadResult.rows[0];
    if (!lead?.external_crm_id) return;

    // Получаем маппинг этапов
    const connResult = await pool.query<{ stage_mapping: Record<string, string> }>(
      'SELECT stage_mapping FROM crm_connections WHERE org_id = $1 AND crm_type = $2',
      [orgId, 'amocrm']
    );
    const stageMapping = connResult.rows[0]?.stage_mapping ?? {};
    const statusId = stageMapping[stage];
    if (!statusId) return;

    await crm.updateLeadStage(parseInt(lead.external_crm_id), parseInt(statusId), notes);
  } catch (err) {
    // Ошибки CRM-синхронизации не должны ломать основной флоу
    logger.error('CRM sync failed (non-critical)', {
      code: safeErrorCode(err),
      orgId,
      leadId,
      stage,
    });
  }
}

/**
 * Создать или найти лид по номеру телефона
 */
export async function getOrCreateLead(
  orgId: string,
  phone: string,
  source: string
): Promise<{ id: string; isNew: boolean }> {
  // Нормализуем телефон
  const normalizedPhone = phone.replace(/\D/g, '');

  // One atomic insert boundary prevents simultaneous normal/control WhatsApp
  // turns from creating duplicate leads or surfacing a unique-key failure.
  const result = await pool.query<{ id: string }>(
    `INSERT INTO leads (org_id, phone, source, stage)
     VALUES ($1, $2, $3, 'new')
     ON CONFLICT (org_id, phone) DO NOTHING
     RETURNING id`,
    [orgId, normalizedPhone, source]
  );
  const newLeadId = result.rows[0]?.id;
  if (!newLeadId) {
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM leads WHERE org_id = $1 AND phone = $2',
      [orgId, normalizedPhone]
    );
    if (!existing.rows[0]) {
      throw new Error('Lead upsert did not return a row');
    }
    return { id: existing.rows[0].id, isNew: false };
  }

  // External CRM is deliberately detached from the inbound consent path.
  // A slow OAuth refresh must never delay a first-contact STOP command.
  void syncNewLeadToAmoCRM(orgId, newLeadId, phone).catch(err => {
    logger.error('CRM lead creation failed (non-critical)', {
      orgId,
      leadId: newLeadId,
      code: safeErrorCode(err),
    });
  });

  return { id: newLeadId, isNew: true };
}

async function syncNewLeadToAmoCRM(
  orgId: string,
  leadId: string,
  phone: string
): Promise<void> {
  const crm = await getAmoCRMClient(orgId);
  if (!crm) return;
  const connResult = await pool.query<{
    pipeline_id: string;
    stage_mapping: Record<string, string>;
  }>(
    'SELECT pipeline_id, stage_mapping FROM crm_connections WHERE org_id = $1 AND crm_type = $2',
    [orgId, 'amocrm']
  );
  const conn = connResult.rows[0];
  const statusId = conn?.stage_mapping['new'];
  if (!conn?.pipeline_id || !statusId) return;
  const crmLeadId = await crm.createLead(
    phone,
    phone,
    Number.parseInt(conn.pipeline_id, 10),
    Number.parseInt(statusId, 10)
  );
  await pool.query(
    `UPDATE leads
     SET external_crm_id = $1, crm_type = 'amocrm', updated_at = NOW()
     WHERE id = $2 AND org_id = $3 AND external_crm_id IS NULL`,
    [String(crmLeadId), leadId, orgId]
  );
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_ -]{1,80}$/u.test(error.name)
    ? error.name
    : 'CRMError';
}
