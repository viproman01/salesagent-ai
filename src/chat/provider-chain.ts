import { config } from '../config';
import { logger } from '../utils/logger';
import {
  CerebrasTextChatClient,
  TextChatProviderError,
  type CerebrasTextChatRequest,
  type TextChatReply,
} from './cerebras-client';
import { GeminiTextChatClient } from './gemini-client';

let providers:
  | Readonly<{
      primary: CerebrasTextChatClient;
      fallback: GeminiTextChatClient;
    }>
  | undefined;
let testGenerator:
  | ((request: CerebrasTextChatRequest) => Promise<TextChatReply>)
  | undefined;

export async function generateAutomaticTextReply(
  request: CerebrasTextChatRequest
): Promise<TextChatReply> {
  if (testGenerator) return testGenerator(request);
  const chain = getProviders();
  try {
    return await chain.primary.reply(request);
  } catch (error) {
    if (
      !(error instanceof TextChatProviderError) ||
      error.code === 'cancelled' ||
      error.code === 'invalid_request'
    ) {
      throw error;
    }
    logger.info('Automatic text reply switched to fallback provider', {
      code: error.code,
    });
    return chain.fallback.reply(request);
  }
}

export function installAutomaticTextReplyGeneratorForTesting(
  generator: (request: CerebrasTextChatRequest) => Promise<TextChatReply>
): () => void {
  if (config.NODE_ENV === 'production') {
    throw new Error('Text reply test generator is disabled in production');
  }
  const previous = testGenerator;
  testGenerator = generator;
  return () => {
    testGenerator = previous;
  };
}

function getProviders(): NonNullable<typeof providers> {
  if (!config.TEXT_CHAT_ENABLED) {
    throw new TextChatProviderError('configuration');
  }
  if (providers) return providers;

  providers = Object.freeze({
    primary: new CerebrasTextChatClient({
      apiKeys: config.CEREBRAS_API_KEYS ?? [],
      model: config.TEXT_CHAT_CEREBRAS_MODEL,
      timeoutMs: config.TEXT_CHAT_TIMEOUT_MS,
    }),
    fallback: new GeminiTextChatClient({
      apiKey: config.GOOGLE_API_KEY,
      model: config.TEXT_CHAT_GEMINI_MODEL,
      timeoutMs: config.TEXT_CHAT_TIMEOUT_MS,
    }),
  });
  return providers;
}
