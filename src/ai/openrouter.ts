import { config } from '../config';
import { logger } from '../utils/logger';
import { AGENT_TOOLS } from './tools';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}
export interface ChatCompletionOptions {
  temperature: number;
  maxTokens: number;
  tools?: boolean;
  timeoutMs?: number;
  providerSort?: 'price' | 'throughput' | 'latency';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export const openRouterTools = AGENT_TOOLS.map(tool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  },
}));

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export function createOpenRouterRequestBody(
  model: string,
  messages: ChatMessage[],
  options: ChatCompletionOptions
): Record<string, unknown> {
  return {
    model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    ...(options.tools ? { tools: openRouterTools, tool_choice: 'auto' } : {}),
    ...(options.providerSort ? {
      provider: { sort: options.providerSort, allow_fallbacks: true },
    } : {}),
    ...(options.reasoningEffort ? {
      reasoning: { effort: options.reasoningEffort, exclude: true },
    } : {}),
  };
}

export async function openRouterChatCompletion(
  model: string,
  messages: ChatMessage[],
  options: ChatCompletionOptions
): Promise<ChatResult> {
  if (!config.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < config.OPENROUTER_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? config.OPENROUTER_TIMEOUT_MS
    );
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.PUBLIC_BASE_URL ?? config.API_BASE_URL,
          'X-Title': 'SalesAgent AI',
        },
        body: JSON.stringify(createOpenRouterRequestBody(model, messages, options)),
      });
      const payload = await response.json().catch(() => ({})) as OpenRouterResponse;
      if (!response.ok) {
        throw new ProviderError(
          `OpenRouter ${response.status}: ${payload.error?.message ?? 'request failed'}`,
          [408, 429, 500, 502, 503, 504].includes(response.status)
        );
      } else {
        const message = payload.choices?.[0]?.message;
        const toolCalls = (message?.tool_calls ?? []).flatMap(call => {
          try { return [{ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) as Record<string, unknown> }]; }
          catch { return []; }
        });
        return {
          text: message?.content?.trim() ?? '',
          toolCalls,
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        };
      }
    } catch (error) {
      if (error instanceof ProviderError && !error.retryable) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < config.OPENROUTER_MAX_ATTEMPTS) {
      await wait(350 * 2 ** attempt + Math.floor(Math.random() * 150));
    }
  }
  logger.error('OpenRouter request failed', { error: lastError?.message, model });
  throw lastError ?? new Error('OpenRouter request failed');
}
