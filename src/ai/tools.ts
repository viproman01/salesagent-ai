import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { Pool } from 'pg';
import { config } from '../config';
import { searchKnowledge } from '../rag/search';
import { logger } from '../utils/logger';
import { sendPolicyGatedWhatsAppReply } from '../whatsapp/safe-outbound';

// ============================================================
// Определения инструментов (tool use) для Claude
// 4 основных инструмента для продажного агента
// ============================================================

const pool = new Pool({ connectionString: config.DATABASE_URL });

export const AGENT_TOOLS: Tool[] = [
  {
    name: 'search_knowledge',
    description: 'Поиск по базе знаний компании. Используй для поиска информации о продуктах, ценах, условиях доставки, акциях. Всегда ищи перед тем как давать ответ о продуктах.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Поисковый запрос на русском языке',
        },
        category: {
          type: 'string',
          enum: ['product', 'faq', 'pricing', 'policy', 'delivery'],
          description: 'Категория поиска (необязательно)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_lead',
    description: 'Обновить статус лида в CRM. Вызывай когда понимаешь намерение клиента, получил новые данные или изменился статус сделки.',
    input_schema: {
      type: 'object' as const,
      properties: {
        stage: {
          type: 'string',
          enum: ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
          description: 'Новый этап воронки продаж',
        },
        name: {
          type: 'string',
          description: 'Имя клиента (если узнал)',
        },
        email: {
          type: 'string',
          description: 'Email клиента',
        },
        score: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Оценка качества лида 0-100',
        },
        deal_amount: {
          type: 'number',
          description: 'Сумма сделки в тийинах (KZT) или копейках (RUB)',
        },
        notes: {
          type: 'string',
          description: 'Заметки о клиенте: интересы, возражения, предпочтения',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Теги: ["VIP", "повторный", "акция"]',
        },
      },
      required: [],
    },
  },
  {
    name: 'book_meeting',
    description: 'Записать клиента на встречу, демо, доставку или перезвон. Используй когда клиент согласен на конкретное время.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Название встречи, например "Консультация по букетам"',
        },
        datetime_utc: {
          type: 'string',
          description: 'Дата и время в ISO 8601 UTC, например "2024-03-15T10:00:00Z"',
        },
        duration_minutes: {
          type: 'number',
          description: 'Длительность в минутах',
          default: 30,
        },
        notes: {
          type: 'string',
          description: 'Дополнительные заметки к встрече',
        },
      },
      required: ['title', 'datetime_utc'],
    },
  },
  {
    name: 'send_whatsapp',
    description: 'Отправить дополнительное сообщение клиенту в WhatsApp (каталог, прайс, фото товаров). НЕ используй для обычных ответов в диалоге.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'Текст сообщения',
        },
        media_url: {
          type: 'string',
          description: 'URL медиафайла (изображение или документ)',
        },
      },
      required: ['text'],
    },
  },
];

// Описания инструментов для Gemini Live (другой формат)
export const GEMINI_TOOL_DECLARATIONS = {
  functionDeclarations: AGENT_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  })),
};

export interface ToolContext {
  orgId: string;
  leadId?: string;
  conversationId: string;
  phone?: string;
  whatsappJid?: string;
}

export interface SearchKnowledgeInput {
  query: string;
  category?: string;
}

export interface UpdateLeadInput {
  stage?: string;
  name?: string;
  email?: string;
  score?: number;
  deal_amount?: number;
  notes?: string;
  tags?: string[];
}

export interface BookMeetingInput {
  title: string;
  datetime_utc: string;
  duration_minutes?: number;
  notes?: string;
}

export interface SendWhatsAppInput {
  text: string;
  media_url?: string;
}

/**
 * Диспетчер исполнения инструментов — вызывается из цикла tool use Claude
 */
export async function executeTool(
  toolName: string,
  toolInput: unknown,
  context: ToolContext
): Promise<string> {
  logger.debug('Выполняю инструмент агента', {
    toolName,
    orgId: context.orgId,
    conversationId: context.conversationId,
  });

  switch (toolName) {
    case 'search_knowledge':
      return executeSearchKnowledge(toolInput as SearchKnowledgeInput, context);

    case 'update_lead':
      return executeUpdateLead(toolInput as UpdateLeadInput, context);

    case 'book_meeting':
      return executeBookMeeting(toolInput as BookMeetingInput, context);

    case 'send_whatsapp':
      return executeSendWhatsApp(toolInput as SendWhatsAppInput, context);

    default:
      logger.warn('Неизвестный инструмент', { toolName });
      return `Ошибка: инструмент "${toolName}" не найден`;
  }
}

async function executeSearchKnowledge(
  input: SearchKnowledgeInput,
  context: ToolContext
): Promise<string> {
  const results = await searchKnowledge(context.orgId, input.query, 5);
  if (results.length === 0) return 'В базе знаний не найдено информации по этому запросу.';
  return results
    .map((r, i) => `[${i + 1}] ${r.content}\n(Категория: ${r.category ?? '—'})`)
    .join('\n\n---\n\n');
}

async function executeUpdateLead(
  input: UpdateLeadInput,
  context: ToolContext
): Promise<string> {
  if (!context.leadId) return 'Ошибка: lead_id не задан в контексте';

  const setParts: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.stage !== undefined)       { setParts.push(`stage = $${idx++}`);       values.push(input.stage); }
  if (input.name !== undefined)        { setParts.push(`name = $${idx++}`);         values.push(input.name); }
  if (input.email !== undefined)       { setParts.push(`email = $${idx++}`);        values.push(input.email); }
  if (input.score !== undefined)       { setParts.push(`score = $${idx++}`);        values.push(input.score); }
  if (input.deal_amount !== undefined) { setParts.push(`deal_amount = $${idx++}`);  values.push(input.deal_amount); }
  if (input.notes !== undefined)       { setParts.push(`notes = $${idx++}`);        values.push(input.notes); }
  if (input.tags !== undefined)        { setParts.push(`tags = $${idx++}`);         values.push(input.tags); }

  if (setParts.length === 0) return 'Нет данных для обновления';

  setParts.push(`updated_at = NOW()`);
  values.push(context.leadId);

  await pool.query(
    `UPDATE leads SET ${setParts.join(', ')} WHERE id = $${idx}`,
    values
  );

  logger.info('Лид обновлён агентом', { leadId: context.leadId, fields: Object.keys(input) });
  return `Данные клиента обновлены: ${Object.keys(input).join(', ')}`;
}

async function executeBookMeeting(
  input: BookMeetingInput,
  context: ToolContext
): Promise<string> {
  if (!context.leadId) return 'Ошибка: lead_id не задан';

  await pool.query(
    `UPDATE leads SET next_contact_at = $1::timestamptz, updated_at = NOW() WHERE id = $2`,
    [input.datetime_utc, context.leadId]
  );

  await pool.query(
    `UPDATE conversations
     SET metadata = jsonb_set(metadata, '{meeting}', $1::jsonb), updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify({
      title: input.title,
      datetime_utc: input.datetime_utc,
      duration_minutes: input.duration_minutes ?? 30,
      notes: input.notes ?? '',
      booked_at: new Date().toISOString(),
    }), context.conversationId]
  );

  logger.info('Встреча запланирована агентом', {
    leadId: context.leadId,
    datetime: input.datetime_utc,
  });

  return `Встреча "${input.title}" запланирована на ${input.datetime_utc}`;
}

async function executeSendWhatsApp(
  input: SendWhatsAppInput,
  context: ToolContext
): Promise<string> {
  try {
    const delivery = await sendPolicyGatedWhatsAppReply({
      orgId: context.orgId,
      conversationId: context.conversationId,
      text: input.text,
    });
    return delivery.accepted
      ? `Сообщение принято безопасной очередью WhatsApp (${delivery.status ?? 'pending'})`
      : 'Отправка заблокирована политикой WhatsApp-диалога';
  } catch (error) {
    logger.error('WhatsApp tool delivery failed', {
      conversationId: context.conversationId,
      code: error instanceof Error ? error.name : 'UnknownError',
    });
    return 'Сервис отправки WhatsApp временно недоступен';
  }
}
