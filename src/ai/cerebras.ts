import { config } from '../config';
import { logger } from '../utils/logger';
import {
  openRouterTools,
  type ChatMessage,
  type ChatResult,
  type ToolCall,
} from './openrouter';

interface CerebrasResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }> | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  message?: string;
  error?: { message?: string };
}

export interface CerebrasModel {
  id: string;
  name: string;
  supportsTools: boolean;
  recommended: boolean;
}

const CEREBRAS_MODEL_NAMES: Record<string, string> = {
  'gemma-4-31b': 'Gemma 4 31B',
  'gpt-oss-120b': 'GPT OSS 120B',
  'zai-glm-4.7': 'Z.ai GLM 4.7',
};

class CerebrasError extends Error {
  constructor(message: string, readonly retryWithAnotherKey: boolean) {
    super(message);
  }
}

let nextKeyOffset = 0;
const keyCooldownUntil = new Map<number, number>();

export function getRotatedKeyIndexes(total: number, start: number, limit: number): number[] {
  if (total <= 0 || limit <= 0) return [];
  const count = Math.min(total, limit);
  return Array.from({ length: count }, (_, index) => (start + index) % total);
}

export function selectReadyKeyIndexes(
  candidates: number[],
  cooldownUntil: ReadonlyMap<number, number>,
  now: number
): number[] {
  const ready = candidates.filter(index => (cooldownUntil.get(index) ?? 0) <= now);
  if (ready.length > 0) return ready;
  return candidates
    .slice()
    .sort((left, right) =>
      (cooldownUntil.get(left) ?? 0) - (cooldownUntil.get(right) ?? 0)
    )
    .slice(0, 1);
}

function claimKeyIndexes(keyCount: number): number[] {
  const start = nextKeyOffset % keyCount;
  nextKeyOffset = (nextKeyOffset + 1) % keyCount;
  const now = Date.now();
  const candidates = getRotatedKeyIndexes(keyCount, start, config.CEREBRAS_MAX_KEY_ATTEMPTS);
  // A previous burst may have put every key on cooldown. Do not fail without
  // making a real request: probe the key whose cooldown expires first.
  return selectReadyKeyIndexes(candidates, keyCooldownUntil, now);
}

function parseToolCalls(
  calls: NonNullable<NonNullable<CerebrasResponse['choices']>[number]['message']>['tool_calls']
): ToolCall[] {
  return (calls ?? []).flatMap(call => {
    try {
      return [{
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
      }];
    } catch {
      return [];
    }
  });
}

export async function cerebrasChatCompletion(
  model: string,
  messages: ChatMessage[],
  options: { temperature: number; maxTokens: number; tools?: boolean }
): Promise<ChatResult> {
  const keys = config.CEREBRAS_API_KEYS;
  if (keys.length === 0) throw new Error('CEREBRAS_API_KEYS is not configured');

  let lastError: Error | null = null;
  for (const keyIndex of claimKeyIndexes(keys.length)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.CEREBRAS_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${keys[keyIndex]}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature,
          max_completion_tokens: options.maxTokens,
          ...(options.tools ? { tools: openRouterTools, tool_choice: 'auto' } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({})) as CerebrasResponse;
      if (!response.ok) {
        throw new CerebrasError(
          `Cerebras ${response.status}: ${payload.error?.message ?? payload.message ?? 'request failed'}`,
          [401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)
        );
      }

      const message = payload.choices?.[0]?.message;
      keyCooldownUntil.delete(keyIndex);
      return {
        text: message?.content?.trim() ?? '',
        toolCalls: parseToolCalls(message?.tool_calls),
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      };
    } catch (error) {
      if (error instanceof CerebrasError && !error.retryWithAnotherKey) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      keyCooldownUntil.set(keyIndex, Date.now() + config.CEREBRAS_KEY_COOLDOWN_MS);
    } finally {
      clearTimeout(timer);
    }
  }

  logger.error('All Cerebras key attempts failed', {
    error: lastError?.message,
    model,
    attemptedKeys: Math.min(keys.length, config.CEREBRAS_MAX_KEY_ATTEMPTS),
  });
  throw lastError ?? new Error('All Cerebras keys are temporarily cooling down');
}

export async function listCerebrasModels(): Promise<CerebrasModel[]> {
  const keys = config.CEREBRAS_API_KEYS;
  if (keys.length === 0) return [];

  let lastError: Error | null = null;
  for (const keyIndex of claimKeyIndexes(keys.length)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.CEREBRAS_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.cerebras.ai/v1/models', {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${keys[keyIndex]}` },
      });
      const payload = await response.json().catch(() => ({})) as {
        data?: Array<{ id: string }>;
        message?: string;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new CerebrasError(
          `Cerebras ${response.status}: ${payload.error?.message ?? payload.message ?? 'model catalog failed'}`,
          [401, 403, 408, 429, 500, 502, 503, 504].includes(response.status)
        );
      }
      keyCooldownUntil.delete(keyIndex);
      return (payload.data ?? [])
        .map(item => ({
          id: item.id,
          name: CEREBRAS_MODEL_NAMES[item.id] ?? item.id,
          supportsTools: true,
          recommended: item.id === 'gemma-4-31b',
        }))
        .sort((left, right) =>
          Number(right.recommended) - Number(left.recommended) || left.name.localeCompare(right.name)
        );
    } catch (error) {
      if (error instanceof CerebrasError && !error.retryWithAnotherKey) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      keyCooldownUntil.set(keyIndex, Date.now() + config.CEREBRAS_KEY_COOLDOWN_MS);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('All Cerebras keys are temporarily cooling down');
}
