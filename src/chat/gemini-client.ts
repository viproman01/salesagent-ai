import {
  TextChatProviderError,
  type CerebrasTextChatRequest,
  type TextChatReply,
} from './cerebras-client';

export type GeminiTextChatClientOptions = Readonly<{
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}>;

type GeminiEnvelope = Readonly<{
  candidates?: unknown;
  usageMetadata?: unknown;
}>;

const MAX_RESPONSE_BYTES = 256 * 1024;

export class GeminiTextChatClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(private readonly options: GeminiTextChatClientOptions) {
    if (
      !options.apiKey.trim() ||
      !options.model.trim() ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 250 ||
      options.timeoutMs > 30_000
    ) {
      throw new TextChatProviderError('configuration');
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async reply(request: CerebrasTextChatRequest): Promise<TextChatReply> {
    if (request.signal?.aborted) {
      throw new TextChatProviderError('cancelled');
    }
    const startedAt = this.now();
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('text-chat-timeout');
    }, this.options.timeoutMs);

    try {
      const model = encodeURIComponent(this.options.model.trim());
      const response = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': this.options.apiKey.trim(),
            'Content-Type': 'application/json',
          },
          body: buildBody(request),
          signal: controller.signal,
        }
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TextChatProviderError(classifyStatus(response.status));
      }
      const envelope = JSON.parse(
        await readBoundedBody(response, controller.signal)
      ) as GeminiEnvelope;
      const parsed = parseReply(envelope);
      return {
        ...parsed,
        latencyMs: Math.max(0, this.now() - startedAt),
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new TextChatProviderError('cancelled');
      }
      if (timedOut) throw new TextChatProviderError('timeout');
      if (error instanceof TextChatProviderError) throw error;
      throw new TextChatProviderError('unavailable');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', relayAbort);
    }
  }
}

function buildBody(request: CerebrasTextChatRequest): string {
  return JSON.stringify({
    systemInstruction: {
      parts: [{ text: request.systemPrompt.trim() }],
    },
    contents: request.messages.map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content.trim() }],
    })),
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxTokens,
    },
  });
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TextChatProviderError('invalid_response');
  }
  if (!response.body) throw new TextChatProviderError('invalid_response');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    if (signal.aborted) throw new Error('response aborted');
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TextChatProviderError('invalid_response');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function parseReply(
  envelope: GeminiEnvelope
): Omit<TextChatReply, 'latencyMs'> {
  if (!Array.isArray(envelope.candidates) || envelope.candidates.length < 1) {
    throw new TextChatProviderError('invalid_response');
  }
  const candidate = record(envelope.candidates[0]);
  if (candidate['finishReason'] !== 'STOP') {
    throw new TextChatProviderError('invalid_response');
  }
  const content = record(candidate['content']);
  const parts = content['parts'];
  if (!Array.isArray(parts)) {
    throw new TextChatProviderError('invalid_response');
  }
  const text = parts
    .map(part => record(part)['text'])
    .filter((part): part is string => typeof part === 'string')
    .join('')
    .trim();
  if (!text || [...text].length > 4_000) {
    throw new TextChatProviderError('invalid_response');
  }
  const usage = record(envelope.usageMetadata, true);
  return {
    text,
    tokensInput: nonNegativeInteger(usage['promptTokenCount']),
    tokensOutput: nonNegativeInteger(usage['candidatesTokenCount']),
  };
}

function record(
  input: unknown,
  optional = false
): Record<string, unknown> {
  if (input === undefined && optional) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TextChatProviderError('invalid_response');
  }
  return input as Record<string, unknown>;
}

function nonNegativeInteger(input: unknown): number {
  return Number.isSafeInteger(input) && Number(input) >= 0 ? Number(input) : 0;
}

function classifyStatus(status: number):
  | 'authentication'
  | 'rate_limited'
  | 'provider_rejected'
  | 'unavailable' {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limited';
  return status >= 500 || status === 408
    ? 'unavailable'
    : 'provider_rejected';
}
