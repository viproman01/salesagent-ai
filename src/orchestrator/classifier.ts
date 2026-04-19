import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import pool from '../db';
import { updateLeadStage } from '../crm/adapter';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

interface Classification {
  stage:        string;
  confidence:   number;
  sentiment:    'positive' | 'neutral' | 'negative';
  key_signals:  string[];
  objections:   string[];
  next_action:  string;
  summary:      string;
}

const CLASSIFIER_SYSTEM_PROMPT = `Ты — классификатор этапов воронки продаж.
Проанализируй диалог менеджера с клиентом и верни ТОЛЬКО валидный JSON без пояснений.

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
 * Вызывается async после каждого обмена сообщениями.
 * Использует Claude Haiku (быстрее и дешевле).
 */
export async function scheduleClassification(
  conversationId: string,
  orgId: string,
  leadId: string
): Promise<void> {
  // Небольшая задержка — даём диалогу устояться
  await new Promise(r => setTimeout(r, 2000));

  try {
    await classifyConversation(conversationId, orgId, leadId);
  } catch (err) {
    logger.error('Classifier error', { error: err, conversationId });
  }
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

  // Вызываем Claude Haiku для классификации
  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system:     CLASSIFIER_SYSTEM_PROMPT,
    messages: [{
      role:    'user',
      content: `Проанализируй следующий диалог:\n\n${dialogText}`,
    }],
  });

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  let classification: Classification;
  try {
    // Извлекаем JSON из ответа
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in classifier response');
    classification = JSON.parse(jsonMatch[0]) as Classification;
  } catch (err) {
    logger.error('Classifier JSON parse error', { error: err, rawText });
    return;
  }

  // Сохраняем классификацию в разговоре
  await pool.query(
    `UPDATE conversations
     SET classification = $1::jsonb,
         summary        = $2,
         sentiment      = $3,
         updated_at     = NOW()
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
