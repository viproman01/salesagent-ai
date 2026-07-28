import { logger } from '../utils/logger';
import pool from '../db';
import { updateLeadStage } from '../crm/adapter';
import { chatCompletion } from '../ai/chat-provider';
import { config } from '../config';
import { z } from 'zod';

const classificationSchema = z.object({
  stage: z.enum([
    'new',
    'contacted',
    'interested',
    'objection',
    'negotiation',
    'meeting_booked',
    'closed_won',
    'closed_lost',
    'nurturing',
  ]),
  confidence: z.coerce.number().min(0).max(1),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  key_signals: z.array(z.string()).max(10).default([]),
  objections: z.array(z.string()).max(10).default([]),
  next_action: z.string().default(''),
  summary: z.string().min(1),
});

export type Classification = z.infer<typeof classificationSchema>;

const CLASSIFICATION_DELAY_MS = 20_000;
const pendingClassifications = new Map<string, NodeJS.Timeout>();

const CLASSIFIER_SYSTEM_PROMPT = `Ты — классификатор этапов воронки продаж.
Проанализируй диалог менеджера с клиентом и верни ТОЛЬКО один короткий валидный JSON.
Не показывай рассуждения, Markdown и блоки кода. Массивы содержат не более 3 коротких элементов.

Формат ответа:
{
  "stage": "один из: new|contacted|interested|objection|negotiation|meeting_booked|closed_won|closed_lost|nurturing",
  "confidence": 0.0..1.0,
  "sentiment": "positive|neutral|negative",
  "key_signals": ["список ключевых сигналов из диалога"],
  "objections": ["список возражений если были"],
  "next_action": "рекомендуемое следующее действие",
  "summary": "краткое резюме разговора 1-2 предложения"
}`;

/**
 * Запустить пост-диалоговую классификацию.
 * Последовательно переносит запуск на 20 секунд после последней реплики.
 * Благодаря trailing debounce живой разговор не создаёт параллельную серию
 * классификаций и не расходует квоту на каждую короткую реплику.
 */
export async function scheduleClassification(
  conversationId: string,
  orgId: string,
  leadId: string
): Promise<void> {
  const previous = pendingClassifications.get(conversationId);
  if (previous) clearTimeout(previous);

  const timer = setTimeout(() => {
    pendingClassifications.delete(conversationId);
    void classifyConversation(conversationId, orgId, leadId).catch(err => {
      logger.warn('Classifier request failed', {
        error: err instanceof Error ? err.message : String(err),
        conversationId,
      });
    });
  }, CLASSIFICATION_DELAY_MS);
  timer.unref();
  pendingClassifications.set(conversationId, timer);
}

function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function parseClassifierResponse(rawText: string): Classification | null {
  const candidates = [
    rawText.trim(),
    ...balancedJsonObjects(rawText),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = classificationSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next complete JSON object found in the response.
    }
  }
  return null;
}

async function requestClassification(dialogText: string, retry: boolean): Promise<string> {
  const model = config.CEREBRAS_API_KEYS.length > 0
    ? `cerebras/${config.CEREBRAS_DEFAULT_MODEL}`
    : config.OPENROUTER_DEFAULT_MODEL;
  const response = await chatCompletion(model, [
    {
      role: 'system',
      content: retry
        ? `${CLASSIFIER_SYSTEM_PROMPT}\nПредыдущая попытка была невалидной. Начни ответ с { и закончи }.`
        : CLASSIFIER_SYSTEM_PROMPT,
    },
    { role: 'user', content: `Диалог:\n${dialogText}` },
  ], { temperature: 0, maxTokens: 512, tools: false });
  return response.text;
}

async function classifyConversation(
  conversationId: string,
  orgId: string,
  leadId: string
): Promise<void> {
  // Загружаем все сообщения разговора
  const messagesResult = await pool.query<{ role: string; content: string }>(
    `SELECT role, content
     FROM messages
     WHERE conversation_id = $1 AND content IS NOT NULL
     ORDER BY created_at ASC
     LIMIT 50`,
    [conversationId]
  );

  if (messagesResult.rows.length < 2) return; // Слишком мало данных

  // Форматируем диалог
  const dialogText = messagesResult.rows
    .map(m => `${m.role === 'user' ? 'Клиент' : 'Менеджер'}: ${m.content}`)
    .join('\n');

  let rawText = await requestClassification(dialogText, false);
  let classification = parseClassifierResponse(rawText);
  if (!classification) {
    rawText = await requestClassification(dialogText, true);
    classification = parseClassifierResponse(rawText);
  }
  if (!classification) {
    logger.warn('Classifier returned invalid structured output', {
      conversationId,
      preview: rawText.replace(/\s+/g, ' ').slice(0, 240),
    });
    return;
  }

  // Сохраняем классификацию в разговоре
  await pool.query(
    `UPDATE conversations
     SET classification = $1,
         summary        = $2,
         sentiment      = $3,
         updated_at     = CURRENT_TIMESTAMP
     WHERE id = $4`,
    [
      JSON.stringify(classification),
      classification.summary,
      classification.sentiment,
      conversationId,
    ]
  );

  // Если уверенность высокая — обновляем этап лида
  if (classification.confidence >= 0.7) {
    await updateLeadStage(orgId, leadId, classification.stage, classification.summary);
    logger.info('Lead stage updated by classifier', {
      conversationId, orgId, leadId,
      stage:      classification.stage,
      confidence: classification.confidence,
    });
  }
}
