import { searchKnowledge } from '../rag/search';
import { logger } from '../utils/logger';
import pool from '../db';
import { z } from 'zod';

// Tool schemas are retained for backward compatibility and are converted to
// OpenRouter's OpenAI-compatible function format in ai/openrouter.ts.

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const AGENT_TOOLS: ToolDefinition[] = [
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
          enum: ['new', 'contacted', 'interested', 'objection', 'negotiation', 'meeting_booked', 'closed_won', 'closed_lost', 'nurturing'],
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

export interface ToolContext {
  orgId: string;
  leadId?: string;
  conversationId: string;
  phone?: string;
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

const toolInputSchemas = {
  search_knowledge: z.object({ query: z.string().min(1).max(1000), category: z.string().max(100).optional() }),
  update_lead: z.object({
    stage: z.enum(['new', 'contacted', 'interested', 'objection', 'negotiation', 'meeting_booked', 'closed_won', 'closed_lost', 'nurturing']).optional(),
    name: z.string().max(255).optional(),
    email: z.string().email().max(255).optional(),
    score: z.number().min(0).max(100).optional(),
    deal_amount: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    notes: z.string().max(5000).optional(),
    tags: z.array(z.string().max(100)).max(50).optional(),
  }),
  book_meeting: z.object({
    title: z.string().min(1).max(255),
    datetime_utc: z.string().datetime(),
    duration_minutes: z.number().int().min(5).max(1440).optional(),
    notes: z.string().max(5000).optional(),
  }),
  send_whatsapp: z.object({ text: z.string().min(1).max(4000), media_url: z.string().url().optional() }),
};

/**
 * Диспетчер исполнения инструментов — вызывается из цикла tool use Claude
 */
export async function executeTool(
  toolName: string,
  toolInput: unknown,
  context: ToolContext
): Promise<string> {
  logger.debug('Выполняю инструмент агента', { toolName, context });

  switch (toolName) {
    case 'search_knowledge': {
      const parsed = toolInputSchemas.search_knowledge.safeParse(toolInput);
      if (!parsed.success) return `Ошибка аргументов search_knowledge: ${parsed.error.message}`;
      return executeSearchKnowledge(parsed.data, context);
    }

    case 'update_lead': {
      const parsed = toolInputSchemas.update_lead.safeParse(toolInput);
      if (!parsed.success) return `Ошибка аргументов update_lead: ${parsed.error.message}`;
      return executeUpdateLead(parsed.data, context);
    }

    case 'book_meeting': {
      const parsed = toolInputSchemas.book_meeting.safeParse(toolInput);
      if (!parsed.success) return `Ошибка аргументов book_meeting: ${parsed.error.message}`;
      return executeBookMeeting(parsed.data, context);
    }

    case 'send_whatsapp': {
      const parsed = toolInputSchemas.send_whatsapp.safeParse(toolInput);
      if (!parsed.success) return `Ошибка аргументов send_whatsapp: ${parsed.error.message}`;
      return executeSendWhatsApp(parsed.data, context);
    }

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
  if (input.tags !== undefined)        { setParts.push(`tags = $${idx++}`);         values.push(JSON.stringify(input.tags)); }

  if (setParts.length === 0) return 'Нет данных для обновления';

  setParts.push(`updated_at = CURRENT_TIMESTAMP`);
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
    `UPDATE leads SET next_contact_at = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [input.datetime_utc, context.leadId]
  );

  await pool.query(
    `UPDATE conversations
     SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.meeting', JSON_EXTRACT($1, '$')), updated_at = CURRENT_TIMESTAMP
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
  const phone = context.phone;
  if (!phone) return 'Ошибка: нет номера телефона для отправки';

  try {
    const { sendWhatsAppMessage } = await import('../channels/whatsapp');
    await sendWhatsAppMessage(phone, input.text);
    return `Сообщение отправлено в WhatsApp на ${phone}`;
  } catch (err) {
    logger.error('Ошибка отправки WhatsApp из инструмента', { err, phone });
    return `Ошибка отправки: ${err instanceof Error ? err.message : String(err)}`;
  }
}
