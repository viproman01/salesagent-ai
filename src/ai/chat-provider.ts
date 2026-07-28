import { config } from '../config';
import { logger } from '../utils/logger';
import { cerebrasChatCompletion } from './cerebras';
import {
  openRouterChatCompletion,
  type ChatCompletionOptions,
  type ChatMessage,
  type ChatResult,
} from './openrouter';

export type TextProvider = 'openrouter' | 'cerebras';
export interface ModelSelection {
  provider: TextProvider;
  model: string;
}

const CEREBRAS_PREFIX = 'cerebras/';

export function parseModelReference(reference: string): ModelSelection {
  if (reference.startsWith(CEREBRAS_PREFIX) && reference.length > CEREBRAS_PREFIX.length) {
    return { provider: 'cerebras', model: reference.slice(CEREBRAS_PREFIX.length) };
  }
  return { provider: 'openrouter', model: reference };
}

export function formatModelReference(provider: TextProvider, model: string): string {
  return provider === 'cerebras' ? `${CEREBRAS_PREFIX}${model}` : model;
}

export async function chatCompletion(
  modelReference: string,
  messages: ChatMessage[],
  options: ChatCompletionOptions
): Promise<ChatResult> {
  const selection = parseModelReference(modelReference);

  if (selection.provider === 'cerebras') {
    try {
      return await cerebrasChatCompletion(selection.model, messages, options);
    } catch (error) {
      if (!config.OPENROUTER_API_KEY) throw error;
      logger.warn('Cerebras unavailable, falling back to OpenRouter', {
        cerebrasModel: selection.model,
        fallbackModel: config.CEREBRAS_FALLBACK_OPENROUTER_MODEL,
        error: error instanceof Error ? error.message : String(error),
      });
      return openRouterChatCompletion(
        config.CEREBRAS_FALLBACK_OPENROUTER_MODEL,
        messages,
        options
      );
    }
  }

  try {
    return await openRouterChatCompletion(selection.model, messages, options);
  } catch (error) {
    if (config.CEREBRAS_API_KEYS.length === 0) throw error;
    logger.warn('OpenRouter unavailable, falling back to Cerebras', {
      openRouterModel: selection.model,
      fallbackModel: config.CEREBRAS_DEFAULT_MODEL,
      error: error instanceof Error ? error.message : String(error),
    });
    return cerebrasChatCompletion(config.CEREBRAS_DEFAULT_MODEL, messages, options);
  }
}
