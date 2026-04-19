import pool from '../db';
import { logger } from '../utils/logger';
import { getAgentResponse } from '../ai/claude-client';
import { getOrCreateLead } from '../crm/adapter';
import { sendWhatsAppMessage } from '../channels/whatsapp';
import { sendTelegramMessage } from '../channels/telegram';
import { scheduleClassification } from './classifier';

export interface IncomingMessage {
  channel:    'whatsapp' | 'telegram' | 'voice';
  phone:      string;
  text:       string;
  externalId?: string;
  metadata?:  Record<string, unknown>;
  orgId?:     string;
}

/**
 * Центральный обработчик входящих сообщений.
 * Определяет организацию → находит/создаёт лид →
 * ведёт разговор через Claude → отвечает в нужный канал →
 * запускает async классификацию.
 */
export async function processIncomingMessage(msg: IncomingMessage): Promise<void> {
  const startTime = Date.now();

  // Определяем организацию по номеру канала
  const orgId = msg.orgId ?? (await resolveOrg(msg.channel, msg.phone));
  if (!orgId) {
    logger.warn('Cannot resolve organization', { channel: msg.channel, phone: msg.phone });
    return;
  }

  // Находим/создаём лид
  const { id: leadId, isNew } = await getOrCreateLead(orgId, msg.phone, msg.channel);
  if (isNew) {
    logger.info('New lead created', { orgId, leadId, phone: msg.phone });
  }

  // Находим/создаём активный разговор
  const conversationId = await getOrCreateConversation(orgId, leadId, msg.channel);

  // Находим активного агента
  const agentResult = await pool.query<{ id: string; system_prompt: string; name: string }>(
    `SELECT id, system_prompt, name FROM agents
     WHERE org_id = $1 AND is_active = true AND $2 = ANY(channels)
     LIMIT 1`,
    [orgId, msg.channel]
  );
  const agent = agentResult.rows[0];
  if (!agent) {
    logger.warn('No active agent for channel', { orgId, channel: msg.channel });
    return;
  }

  // Сохраняем сообщение пользователя
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content)
     VALUES ($1, 'user', $2)`,
    [conversationId, msg.text]
  );

  // Получаем ответ от Claude
  const agentResponse = await getAgentResponse(
    agent.system_prompt,
    msg.text,
    { orgId, leadId, conversationId, phone: msg.phone }
  );

  // Сохраняем ответ агента
  await pool.query(
    `INSERT INTO messages
       (conversation_id, role, content, tokens_input, tokens_output, latency_ms)
     VALUES ($1, 'assistant', $2, $3, $4, $5)`,
    [
      conversationId,
      agentResponse.text,
      agentResponse.tokensInput,
      agentResponse.tokensOutput,
      agentResponse.latencyMs,
    ]
  );

  // Обновляем время последнего контакта
  await pool.query(
    'UPDATE leads SET last_contact_at = NOW() WHERE id = $1',
    [leadId]
  );

  // Отправляем ответ обратно в канал
  await sendResponse(msg.channel, msg.phone, agentResponse.text, msg.metadata);

  // Запускаем асинхронную классификацию (не блокирует основной флоу)
  scheduleClassification(conversationId, orgId, leadId).catch(err => {
    logger.error('Classification scheduling failed', { error: err, conversationId });
  });

  logger.info('Message processed', {
    orgId, leadId, conversationId,
    channel:      msg.channel,
    latencyMs:    Date.now() - startTime,
    toolsUsed:    agentResponse.toolsUsed,
  });
}

/**
 * Найти или создать активный разговор
 */
async function getOrCreateConversation(
  orgId: string,
  leadId: string,
  channel: string
): Promise<string> {
  // Ищем активный разговор (не старше 24 часов)
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM conversations
     WHERE org_id = $1 AND lead_id = $2 AND channel = $3::channel_type
       AND status = 'active'
       AND started_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, leadId, channel]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0]!.id;
  }

  // Создаём новый разговор
  const result = await pool.query<{ id: string }>(
    `INSERT INTO conversations (org_id, lead_id, channel, status)
     VALUES ($1, $2, $3::channel_type, 'active')
     RETURNING id`,
    [orgId, leadId, channel]
  );
  return result.rows[0]!.id;
}

/**
 * Определить организацию по каналу и номеру телефона
 * В продакшне — по webhook secret или номеру аккаунта Wazzup
 * Здесь — берём первую организацию (MVP)
 */
async function resolveOrg(_channel: string, _phone: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM organizations LIMIT 1'
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Отправить ответ в нужный канал
 */
async function sendResponse(
  channel: string,
  phone: string,
  text: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (channel === 'whatsapp') {
    await sendWhatsAppMessage(phone, text);
  } else if (channel === 'telegram') {
    const chatId = (metadata?.['telegramChatId'] as string | undefined) ?? phone;
    await sendTelegramMessage(chatId, text);
  }
  // Voice канал отвечает через Gemini Live WebSocket напрямую
}
