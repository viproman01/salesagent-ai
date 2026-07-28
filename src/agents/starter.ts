import { randomUUID } from 'crypto';
import type { QueryResult } from '../db';

export const MOMMY_VOICE_ID = '779673f3-895f-4935-b6b5-b031dc78b319';

export const STARTER_AGENT_PROMPT = `Ты — Mommy, нежный, внимательный и уверенный голосовой ассистент. Разговаривай естественно, тепло и коротко. Сначала пойми потребность человека, затем помоги выбрать следующий простой шаг. Не выдумывай факты, цены или условия. Если вопрос требует расчёта или глубокого анализа, дай короткий предварительный ответ и продолжай разговор, пока фоновая модель готовит точный вывод.`;

export function starterVoiceConfig(): Record<string, unknown> {
  return {
    version: 2,
    provider: 'cartesia',
    model: 'sonic-3.5',
    voiceId: MOMMY_VOICE_ID,
    language: 'ru-RU',
    speed: 1.08,
    stt: {
      provider: 'openrouter',
      model: 'deepgram/nova-3',
      language: 'ru',
    },
    vad: {
      silenceMs: 480,
      maxUtteranceSeconds: 30,
    },
    orchestration: {
      fastModel: 'cerebras/gemma-4-31b',
      deepModel: 'deepseek/deepseek-v4-pro',
      complexRouting: true,
    },
  };
}

interface QueryExecutor {
  query<T = unknown>(statement: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

export async function createStarterVoiceAgent(
  executor: QueryExecutor,
  orgId: string
): Promise<string> {
  const id = randomUUID();
  await executor.query(
    `INSERT INTO agents
       (id, org_id, name, system_prompt, channels, voice_config,
        model_text, temperature, max_tokens, is_active)
     VALUES ($1,$2,'Mommy',$3,$4,$5,'cerebras/gemma-4-31b',0.45,120,true)`,
    [
      id,
      orgId,
      STARTER_AGENT_PROMPT,
      JSON.stringify(['voice']),
      JSON.stringify(starterVoiceConfig()),
    ]
  );
  return id;
}

export async function ensureStarterVoiceAgent(
  executor: QueryExecutor,
  orgId: string
): Promise<{ id: string; created: boolean }> {
  const existing = await executor.query<{ id: string }>(
    `SELECT id FROM agents
     WHERE org_id = $1 AND is_active = true
     ORDER BY created_at ASC LIMIT 1`,
    [orgId]
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  return {
    id: await createStarterVoiceAgent(executor, orgId),
    created: true,
  };
}
