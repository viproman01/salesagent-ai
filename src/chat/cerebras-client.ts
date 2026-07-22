export type TextChatMessage = Readonly<{
  role: 'user' | 'assistant';
  content: string;
}>;

export type TextChatReply = Readonly<{
  text: string;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number;
}>;

export type CerebrasTextChatRequest = Readonly<{
  conversationId: string;
  systemPrompt: string;
  messages: readonly TextChatMessage[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}>;

export type CerebrasTextChatClientOptions = Readonly<{
  apiKeys: readonly string[];
  model: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}>;

export type TextChatProviderErrorCode =
  | 'configuration'
  | 'invalid_request'
  | 'cancelled'
  | 'timeout'
  | 'rate_limited'
  | 'authentication'
  | 'provider_rejected'
  | 'invalid_response'
  | 'unavailable';

/** Safe for logs and API responses: never contains keys or provider bodies. */
export class TextChatProviderError extends Error {
  constructor(public readonly code: TextChatProviderErrorCode) {
    super(`Text chat provider failed: ${code}`);
    this.name = 'TextChatProviderError';
  }
}

type KeySlot = {
  readonly key: string;
  disabled: boolean;
  cooldownUntilMs: number;
};

type ProviderEnvelope = Readonly<{
  choices?: unknown;
  usage?: unknown;
}>;

const CEREBRAS_CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions';
const MAX_SYSTEM_CHARACTERS = 20_000;
const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_TOTAL_MESSAGE_CHARACTERS = 50_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class CerebrasTextChatClient {
  private readonly slots: KeySlot[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(private readonly options: CerebrasTextChatClientOptions) {
    const keys = [
      ...new Set(options.apiKeys.map(key => key.trim()).filter(Boolean)),
    ];
    if (keys.length === 0 || !options.model.trim()) {
      throw new TextChatProviderError('configuration');
    }
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 250 ||
      options.timeoutMs > 30_000
    ) {
      throw new TextChatProviderError('configuration');
    }
    this.slots = keys.map(key => ({
      key,
      disabled: false,
      cooldownUntilMs: 0,
    }));
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async reply(request: CerebrasTextChatRequest): Promise<TextChatReply> {
    validateRequest(request);
    const startedAt = this.now();
    const preferred = stableHash(request.conversationId) % this.slots.length;
    const attempted = new Set<number>();
    const attempts = Math.min(2, this.slots.length);
    let lastCode: TextChatProviderErrorCode = 'unavailable';

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (request.signal?.aborted) {
        throw new TextChatProviderError('cancelled');
      }
      const selected = this.selectKey(preferred, attempted, this.now());
      if (!selected) break;
      attempted.add(selected.index);

      try {
        const envelope = await this.request(selected.key, request);
        const parsed = parseReply(envelope);
        return {
          ...parsed,
          latencyMs: Math.max(0, this.now() - startedAt),
        };
      } catch (error) {
        if (error instanceof ProviderHttpError) {
          lastCode = classifyStatus(error.status);
          this.updateSlot(selected.index, error);
          if (!retryableStatus(error.status)) {
            throw new TextChatProviderError(lastCode);
          }
          continue;
        }
        if (error instanceof TextChatProviderError) throw error;
        lastCode = 'unavailable';
        this.slots[selected.index]!.cooldownUntilMs = this.now() + 1_000;
      }
    }

    throw new TextChatProviderError(lastCode);
  }

  private selectKey(
    preferred: number,
    attempted: ReadonlySet<number>,
    nowMs: number
  ): Readonly<{ index: number; key: string }> | undefined {
    for (let offset = 0; offset < this.slots.length; offset += 1) {
      const index = (preferred + offset) % this.slots.length;
      const slot = this.slots[index]!;
      if (
        attempted.has(index) ||
        slot.disabled ||
        slot.cooldownUntilMs > nowMs
      ) {
        continue;
      }
      return { index, key: slot.key };
    }
    return undefined;
  }

  private updateSlot(index: number, error: ProviderHttpError): void {
    const slot = this.slots[index]!;
    if (error.status === 401 || error.status === 403) {
      slot.disabled = true;
      return;
    }
    if (error.status === 429) {
      slot.cooldownUntilMs = this.now() + retryDelayMs(error.headers);
      return;
    }
    if (error.status >= 500 || error.status === 408) {
      slot.cooldownUntilMs = this.now() + 1_000;
    }
  }

  private async request(
    apiKey: string,
    request: CerebrasTextChatRequest
  ): Promise<ProviderEnvelope> {
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('text-chat-timeout');
    }, this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(CEREBRAS_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: buildBody(this.options.model, request),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderHttpError(response.status, response.headers);
      }
      const body = await readBoundedBody(response, controller.signal);
      try {
        return JSON.parse(body) as ProviderEnvelope;
      } catch {
        throw new TextChatProviderError('invalid_response');
      }
    } catch (error) {
      if (request.signal?.aborted) {
        throw new TextChatProviderError('cancelled');
      }
      if (timedOut) throw new TextChatProviderError('timeout');
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', relayAbort);
    }
  }
}

class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers
  ) {
    super('Text chat provider rejected the request');
    this.name = 'ProviderHttpError';
  }
}

function validateRequest(request: CerebrasTextChatRequest): void {
  if (
    request.signal?.aborted ||
    !request.conversationId.trim() ||
    !request.systemPrompt.trim()
  ) {
    throw new TextChatProviderError(
      request.signal?.aborted ? 'cancelled' : 'invalid_request'
    );
  }
  if (characterCount(request.systemPrompt) > MAX_SYSTEM_CHARACTERS) {
    throw new TextChatProviderError('invalid_request');
  }
  if (
    request.messages.length === 0 ||
    request.messages.length > 41 ||
    !Number.isInteger(request.maxTokens) ||
    request.maxTokens < 64 ||
    request.maxTokens > 4_096 ||
    !Number.isFinite(request.temperature) ||
    request.temperature < 0 ||
    request.temperature > 1
  ) {
    throw new TextChatProviderError('invalid_request');
  }
  let total = 0;
  for (const message of request.messages) {
    const count = characterCount(message.content);
    if (!message.content.trim() || count > MAX_MESSAGE_CHARACTERS) {
      throw new TextChatProviderError('invalid_request');
    }
    total += count;
  }
  if (total > MAX_TOTAL_MESSAGE_CHARACTERS) {
    throw new TextChatProviderError('invalid_request');
  }
}

function buildBody(
  model: string,
  request: CerebrasTextChatRequest
): string {
  return JSON.stringify({
    model: model.trim(),
    messages: [
      { role: 'system', content: request.systemPrompt.trim() },
      ...request.messages.map(message => ({
        role: message.role,
        content: message.content.trim(),
      })),
    ],
    reasoning_effort: 'none',
    stream: false,
    temperature: request.temperature,
    max_completion_tokens: request.maxTokens,
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
  if (!response.body) {
    throw new TextChatProviderError('invalid_response');
  }

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

function parseReply(envelope: ProviderEnvelope): Omit<TextChatReply, 'latencyMs'> {
  if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
    throw new TextChatProviderError('invalid_response');
  }
  const choice = record(envelope.choices[0]);
  if (choice['finish_reason'] !== 'stop') {
    throw new TextChatProviderError('invalid_response');
  }
  const message = record(choice['message']);
  const content = message['content'];
  if (
    typeof content !== 'string' ||
    !content.trim() ||
    characterCount(content.trim()) > MAX_MESSAGE_CHARACTERS
  ) {
    throw new TextChatProviderError('invalid_response');
  }
  const usage = record(envelope.usage, true);
  return {
    text: content.trim(),
    tokensInput: nonNegativeInteger(usage['prompt_tokens']),
    tokensOutput: nonNegativeInteger(usage['completion_tokens']),
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

function retryableStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

function classifyStatus(status: number): TextChatProviderErrorCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limited';
  return status >= 500 || status === 408
    ? 'unavailable'
    : 'provider_rejected';
}

function retryDelayMs(headers: Headers): number {
  const seconds = Number(headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(60_000, Math.max(250, seconds * 1_000))
    : 60_000;
}

function stableHash(input: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function characterCount(input: string): number {
  return [...input].length;
}
