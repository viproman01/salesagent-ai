import pool from '../db';
import { logger } from '../utils/logger';
import { getAgentResponse } from '../ai/claude-client';
import { getOrCreateLead } from '../crm/adapter';
import { sendWhatsAppMessage } from '../channels/whatsapp';
import { sendTelegramMessage } from '../channels/telegram';
import { scheduleClassification } from './classifier';
import { randomUUID } from 'crypto';

export interface IncomingMessage {
  channel:    'whatsapp' | 'telegram' | 'voice' | 'chat';
  phone:      string;
  text:       string;
  externalId?: string;
  metadata?:  Record<string, unknown>;
  orgId?:     string;
  agentId?:   string;
  modelOverride?: string;
  maxTokensOverride?: number;
  systemContext?: string;
}

export interface AgentTurnResult {
  text: string;
  orgId: string;
  leadId: string;
  conversationId: string;
  agentId: string;
  toolsUsed: string[];
  llm: {
    model: string;
    latencyMs: number;
    tokensInput: number;
    tokensOutput: number;
  };
}

/**
 * Центральный обработчик входящих сообщений.
 * Определяет организацию → находит/создаёт лид →
 * ведёт разговор через Claude → отвечает в нужный канал →
 * запускает async классификацию.
 */
export async function processIncomingMessage(msg: IncomingMessage): Promise<void> {
  const startTime = Date.now();
  const result = await generateAgentTurn(msg);
  await sendResponse(msg.channel, msg.phone, result.text, msg.metadata);

  logger.info('Message processed', {
    orgId: result.orgId,
    leadId: result.leadId,
    conversationId: result.conversationId,
    channel: msg.channel,
    latencyMs: Date.now() - startTime,
    toolsUsed: result.toolsUsed,
  });
}

export async function generateAgentTurn(msg: IncomingMessage): Promise<AgentTurnResult> {
  const orgId = msg.orgId;
  if (!orgId) {
    throw new Error('Organization is required for incoming messages');
  }

  const agentResult = await pool.query<{ id: string; system_prompt: string; name: string; model_text: string; temperature: number; max_tokens: number }>(
    `SELECT id, system_prompt, name, model_text, temperature, max_tokens FROM agents
     WHERE org_id = $1 AND is_active = true
       ${msg.agentId ? 'AND id = $2' : 'AND JSON_CONTAINS(channels, JSON_QUOTE($2))'}
     LIMIT 1`,
    [orgId, msg.agentId ?? msg.channel]
  );
  const agent = agentResult.rows[0];
  if (!agent) {
    throw new Error('No active agent for this organization and channel');
  }

  const { id: leadId, isNew } = await getOrCreateLead(orgId, msg.phone, msg.channel);
  if (isNew) {
    logger.info('New lead created', { orgId, leadId, phone: msg.phone });
  }

  const conversationId = await getOrCreateConversation(orgId, leadId, agent.id, msg.channel);

  await pool.query(
    `INSERT INTO messages (id, conversation_id, role, content)
     VALUES ($1, $2, 'user', $3)`,
    [randomUUID(), conversationId, msg.text]
  );
  await pool.query(
    `UPDATE conversations
     SET message_count = message_count + 1, last_message_at = CURRENT_TIMESTAMP, agent_id = $1
     WHERE id = $2`,
    [agent.id, conversationId]
  );

  const agentResponse = await getAgentResponse(
    agent.system_prompt,
    msg.text,
    { orgId, leadId, conversationId, phone: msg.phone },
    {
      model: msg.modelOverride ?? agent.model_text,
      temperature: agent.temperature,
      maxTokens: msg.maxTokensOverride ?? agent.max_tokens,
      systemContext: msg.systemContext,
    }
  );

  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, role, content, tokens_input, tokens_output, latency_ms)
     VALUES ($1, $2, 'assistant', $3, $4, $5, $6)`,
    [
      randomUUID(), conversationId,
      agentResponse.text,
      agentResponse.tokensInput,
      agentResponse.tokensOutput,
      agentResponse.latencyMs,
    ]
  );
  await pool.query(
    `UPDATE conversations
     SET message_count = message_count + 1, last_message_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [conversationId]
  );

  await pool.query(
    'UPDATE leads SET last_contact_at = CURRENT_TIMESTAMP WHERE id = $1',
    [leadId]
  );

  scheduleClassification(conversationId, orgId, leadId).catch(err => {
    logger.error('Classification scheduling failed', { error: err, conversationId });
  });

  return {
    text: agentResponse.text,
    orgId,
    leadId,
    conversationId,
    agentId: agent.id,
    toolsUsed: agentResponse.toolsUsed,
    llm: {
      model: msg.modelOverride ?? agent.model_text,
      latencyMs: agentResponse.latencyMs,
      tokensInput: agentResponse.tokensInput,
      tokensOutput: agentResponse.tokensOutput,
    },
  };
}

/**
 * Найти или создать активный разговор
 */
async function getOrCreateConversation(
  orgId: string,
  leadId: string,
  agentId: string,
  channel: string
): Promise<string> {
  // Ищем активный разговор (не старше 24 часов)
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM conversations
     WHERE org_id = $1 AND lead_id = $2 AND channel = $3
       AND status = 'active'
       AND started_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 24 HOUR)
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, leadId, channel]
  );
  if (existing.rows.length > 0) {
    await pool.query('UPDATE conversations SET agent_id = $1 WHERE id = $2', [agentId, existing.rows[0]!.id]);
    return existing.rows[0]!.id;
  }

  // Создаём новый разговор
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversations (id, org_id, lead_id, agent_id, channel, status)
     VALUES ($1, $2, $3, $4, $5, 'active')`,
    [id, orgId, leadId, agentId, channel]
  );
  return id;
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
