import { randomUUID } from 'crypto';
import pool from '../db';
import { config } from '../config';
import { openRouterChatCompletion, type ChatMessage } from '../ai/openrouter';
import { logger } from '../utils/logger';

export type VoiceBackgroundStatus =
  | 'idle'
  | 'processing'
  | 'ready'
  | 'delivering'
  | 'delivered'
  | 'superseded'
  | 'dismissed'
  | 'failed';

export interface VoiceComplexity {
  complex: boolean;
  score: number;
  reasons: string[];
}

export interface VoiceBackgroundTask {
  id: string;
  sessionId: string;
  sourceUtteranceId: string;
  question: string;
  status: Exclude<VoiceBackgroundStatus, 'idle'>;
  model: string;
  answer: string | null;
  deliveredText: string | null;
  errorMessage: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
  relevant: boolean;
  laterTurns: number;
}

interface VoiceBackgroundTaskRow {
  id: string;
  session_id: string;
  source_utterance_id: string;
  question: string;
  status: Exclude<VoiceBackgroundStatus, 'idle'>;
  model: string;
  answer: string | null;
  delivered_text: string | null;
  error_message: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  later_turns?: number | string;
}

const COMPLEX_PATTERNS: Array<[RegExp, string, number]> = [
  [/(проанализируй|анализ|исследуй|исследование)/i, 'analysis', 3],
  [/(сравни|сравнение|что лучше|плюсы и минусы|преимуществ\w* и недостатк\w*)/i, 'comparison', 3],
  [/(рассчитай|посчитай|формула|окупаемост|рентабельност|бюджет|прогноз)/i, 'calculation', 3],
  [/(стратеги|архитектур|интеграц|план внедрения|дорожн\w* карт|пошагов)/i, 'multi_step', 3],
  [/(риск|юридическ|финансов\w* модел|техническ\w* решен|безопасност)/i, 'high_stakes', 2],
  [/(почему|докажи|обоснуй|причин\w*|последстви\w*)/i, 'reasoning', 2],
  [/(подробно|глубоко|комплексн|несколько вариантов)/i, 'depth_requested', 2],
];

function normalizeTask(row: VoiceBackgroundTaskRow): VoiceBackgroundTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceUtteranceId: row.source_utterance_id,
    question: row.question,
    status: row.status,
    model: row.model,
    answer: row.answer,
    deliveredText: row.delivered_text,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    relevant: Number(row.later_turns ?? 0) === 0,
    laterTurns: Number(row.later_turns ?? 0),
  };
}

export function assessVoiceComplexity(text: string): VoiceComplexity {
  const normalized = text.trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const reasons: string[] = [];
  let score = 0;

  for (const [pattern, reason, weight] of COMPLEX_PATTERNS) {
    if (!pattern.test(normalized)) continue;
    score += weight;
    reasons.push(reason);
  }
  if (words.length >= 30) {
    score += 2;
    reasons.push('long_question');
  } else if (words.length >= 20) {
    score += 1;
    reasons.push('medium_question');
  }
  if ((normalized.match(/\?/g) ?? []).length >= 2) {
    score += 1;
    reasons.push('multiple_questions');
  }
  if ((normalized.match(/(?:^|\s)(?:и|или|затем|после этого|при этом)(?=\s|$)/gi) ?? []).length >= 4) {
    score += 1;
    reasons.push('multiple_constraints');
  }

  return { complex: score >= 3, score, reasons };
}

async function loadVoiceHistory(sessionId: string): Promise<ChatMessage[]> {
  const result = await pool.query<{ transcript: string; assistant_text: string }>(
    `SELECT transcript, assistant_text
     FROM voice_utterances
     WHERE session_id = $1 AND status = 'completed'
       AND transcript IS NOT NULL AND assistant_text IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 8`,
    [sessionId]
  );
  return result.rows.reverse().flatMap(row => [
    { role: 'user' as const, content: row.transcript },
    { role: 'assistant' as const, content: row.assistant_text },
  ]);
}

async function executeDeepTask(
  taskId: string,
  sessionId: string,
  question: string,
  model: string
): Promise<void> {
  try {
    const history = await loadVoiceHistory(sessionId);
    const result = await openRouterChatCompletion(model, [
      {
        role: 'system',
        content: `Ты — фоновый аналитический эксперт голосового агента.
Глубоко проверь сложный вопрос клиента и подготовь содержательный вывод для быстрого голосового агента.
Не упоминай внутреннюю маршрутизацию, модели или фоновую задачу.
Не здоровайся, не представляйся и не заменяй анализ просьбой дать больше данных.
Не выдумывай отраслевые показатели, цены, валюту, страну или применимые законы.
Если точный расчёт невозможен без входных данных, всё равно назови основные риски, формулу или сценарии, а затем перечисли, какие 2–3 показателя нужны для уточнения.
Сформулируй финальный текст так, чтобы голосовой агент мог произнести его клиенту напрямую без пересказа другой моделью.
Верни практичный ответ на русском языке: сначала прямой вывод, затем ключевое обоснование.
Не используй Markdown. Максимум 4 коротких предложения и 700 символов.`,
      },
      ...history,
      {
        role: 'user',
        content: `Сложный вопрос клиента, который нужно именно проанализировать:
${question}`,
      },
    ], {
      temperature: 0.2,
      maxTokens: config.VOICE_DEEP_MAX_TOKENS,
      tools: false,
      timeoutMs: config.VOICE_DEEP_TIMEOUT_MS,
      providerSort: 'throughput',
      reasoningEffort: 'high',
    });
    const answer = result.text.trim();
    if (!answer) throw new Error('Deep model returned an empty answer');
    await pool.query(
      `UPDATE voice_deep_tasks
       SET status = 'ready', answer = $1, completed_at = CURRENT_TIMESTAMP,
           error_message = NULL
       WHERE id = $2 AND status = 'processing'`,
      [answer, taskId]
    );
    logger.info('Voice deep analysis completed', {
      taskId,
      sessionId,
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Deep analysis failed';
    await pool.query(
      `UPDATE voice_deep_tasks
       SET status = 'failed', error_message = $1, completed_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'processing'`,
      [message, taskId]
    ).catch(dbError => {
      logger.error('Voice deep task failure could not be persisted', { taskId, dbError });
    });
    logger.error('Voice deep analysis failed', { taskId, sessionId, model, error });
  }
}

export async function scheduleVoiceDeepTask(input: {
  sessionId: string;
  sourceUtteranceId: string;
  question: string;
  model?: string;
}): Promise<{ task: VoiceBackgroundTask; triggered: boolean }> {
  await pool.query(
    `UPDATE voice_deep_tasks
     SET status = 'superseded',
         error_message = 'Replaced by a newer complex question'
     WHERE session_id = $1 AND status IN ('processing','ready')`,
    [input.sessionId]
  );

  const id = randomUUID();
  const model = input.model ?? config.VOICE_DEEP_MODEL;
  await pool.query(
    `INSERT INTO voice_deep_tasks
       (id, session_id, source_utterance_id, question, status, model)
     VALUES ($1,$2,$3,$4,'processing',$5)`,
    [id, input.sessionId, input.sourceUtteranceId, input.question, model]
  );
  const task: VoiceBackgroundTask = {
    id,
    sessionId: input.sessionId,
    sourceUtteranceId: input.sourceUtteranceId,
    question: input.question,
    status: 'processing',
    model,
    answer: null,
    deliveredText: null,
    errorMessage: null,
    createdAt: new Date(),
    completedAt: null,
    relevant: true,
    laterTurns: 0,
  };
  void executeDeepTask(id, input.sessionId, input.question, model);
  return { task, triggered: true };
}

export async function getVoiceBackgroundState(
  sessionId: string
): Promise<VoiceBackgroundTask | null> {
  await pool.query(
    `UPDATE voice_deep_tasks
     SET status = 'failed', error_message = 'Background analysis timed out',
         completed_at = CURRENT_TIMESTAMP
     WHERE session_id = $1 AND status = 'processing'
       AND created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 3 MINUTE)`,
    [sessionId]
  );
  await pool.query(
    `UPDATE voice_deep_tasks
     SET status = 'ready', error_message = 'Delivery was interrupted and will be retried'
     WHERE session_id = $1 AND status = 'delivering'
       AND created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 3 MINUTE)`,
    [sessionId]
  );
  const result = await pool.query<VoiceBackgroundTaskRow>(
    `SELECT t.id, t.session_id, t.source_utterance_id, t.question, t.status,
            t.model, t.answer, t.delivered_text, t.error_message,
            t.created_at, t.completed_at,
            (SELECT COUNT(*) FROM voice_utterances u
             WHERE u.session_id = t.session_id
               AND u.id <> t.source_utterance_id
               AND u.created_at >= t.created_at) AS later_turns
     FROM voice_deep_tasks t
     WHERE t.session_id = $1
     ORDER BY t.created_at DESC LIMIT 1`,
    [sessionId]
  );
  if (
    !result.rows[0]
    || result.rows[0].status === 'delivered'
    || result.rows[0].status === 'dismissed'
  ) return null;
  return normalizeTask(result.rows[0]);
}

export async function claimReadyVoiceBackgroundTask(
  sessionId: string,
  taskId: string,
  force = false
): Promise<VoiceBackgroundTask | null> {
  const claimed = await pool.query(
    `UPDATE voice_deep_tasks
     SET status = 'delivering'
     WHERE id = $1 AND session_id = $2 AND status = 'ready'
       AND delivered_at IS NULL
       AND (
         $3 = true OR NOT EXISTS (
           SELECT 1 FROM voice_utterances u
           WHERE u.session_id = voice_deep_tasks.session_id
             AND u.id <> voice_deep_tasks.source_utterance_id
             AND u.created_at >= voice_deep_tasks.created_at
         )
       )`,
    [taskId, sessionId, force]
  );
  if (claimed.affectedRows === 0) return null;
  const result = await pool.query<VoiceBackgroundTaskRow>(
    `SELECT id, session_id, source_utterance_id, question, status, model,
            answer, delivered_text, error_message, created_at, completed_at,
            0 AS later_turns
     FROM voice_deep_tasks WHERE id = $1`,
    [taskId]
  );
  return result.rows[0] ? normalizeTask(result.rows[0]) : null;
}

export async function dismissVoiceBackgroundTask(
  sessionId: string,
  taskId: string
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE voice_deep_tasks
     SET status = 'dismissed', error_message = 'Dismissed by the operator'
     WHERE id = $1 AND session_id = $2
       AND status IN ('processing','ready','superseded','failed')`,
    [taskId, sessionId]
  );
  return result.affectedRows > 0;
}

export async function completeVoiceBackgroundDelivery(
  taskId: string,
  deliveredText: string
): Promise<void> {
  await pool.query(
    `UPDATE voice_deep_tasks
     SET status = 'delivered', delivered_text = $1,
         delivered_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND status = 'delivering'`,
    [deliveredText, taskId]
  );
}

export async function releaseVoiceBackgroundTask(taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 500) : 'Delivery failed';
  await pool.query(
    `UPDATE voice_deep_tasks
     SET status = 'ready', error_message = $1
     WHERE id = $2 AND status = 'delivering'`,
    [message, taskId]
  );
}

export function buildFastVoiceContext(input: {
  complexity: VoiceComplexity;
  backgroundTask?: VoiceBackgroundTask | null;
}): string {
  const instructions = [
    'Отвечай максимально быстро и естественно, не более 2 коротких предложений.',
    'Не повторяй вопрос клиента и не используй списки или Markdown.',
  ];
  if (input.complexity.complex) {
    instructions.push(
      'Вопрос сложный и отправлен фоновому эксперту. Дай только полезный предварительный ответ без догадок, скажи, что уточняешь детали, и задай один короткий вопрос для продолжения разговора.'
    );
  } else if (input.backgroundTask?.status === 'processing') {
    instructions.push(
      'Предыдущий сложный вопрос ещё проверяется фоновым экспертом. Продолжай текущий диалог и при необходимости кратко скажи, что уточнение ещё готовится.'
    );
  }
  return instructions.join('\n');
}
