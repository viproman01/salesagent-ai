import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

function normalizeMysqlUrl(value: string): string {
  return value.startsWith('jdbc:mysql://') ? value.slice('jdbc:'.length) : value;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  APP_BUILD_ID: z.string().default('development'),
  API_BASE_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  MYSQL_URL: z.string().min(1).transform(normalizeMysqlUrl),
  AUTO_MIGRATE: z.string().default('true').transform(value => value === 'true'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_PASSWORD: z.string().optional(),

  // The dashboard can run before an OpenRouter key is provisioned. AI routes
  // validate this value at call time and return a concrete configuration error.
  OPENROUTER_API_KEY: z.string().optional().transform(value => value?.trim() || undefined),
  OPENROUTER_DEFAULT_MODEL: z.string().default('openrouter/auto'),
  OPENROUTER_EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),
  OPENROUTER_TIMEOUT_MS: z.string().default('12000').transform(Number),
  OPENROUTER_MAX_ATTEMPTS: z.string().default('2').transform(Number),
  OPENROUTER_STT_MODEL: z.string().default('deepgram/nova-3'),
  OPENROUTER_STT_FALLBACK_MODEL: z.string().default('openai/whisper-large-v3-turbo'),
  OPENROUTER_STT_LANGUAGE: z.string().default('ru'),
  OPENROUTER_STT_TIMEOUT_MS: z.string().default('30000').transform(Number),
  OPENROUTER_STT_MAX_ATTEMPTS: z.string().default('2').transform(Number),

  // Multiple Cerebras keys are distributed round-robin. A request moves to
  // the next key on quota, authentication, timeout, or transient API errors.
  CEREBRAS_API_KEYS: z.string().default('').transform(value =>
    value.split(',').map(key => key.trim()).filter(Boolean)
  ),
  CEREBRAS_DEFAULT_MODEL: z.string().default('gemma-4-31b'),
  CEREBRAS_FALLBACK_OPENROUTER_MODEL: z.string().default('openrouter/auto'),
  CEREBRAS_TIMEOUT_MS: z.string().default('12000').transform(Number),
  CEREBRAS_MAX_KEY_ATTEMPTS: z.string().default('5').transform(Number),
  CEREBRAS_KEY_COOLDOWN_MS: z.string().default('60000').transform(Number),

  FISH_AUDIO_API_KEY: z.string().optional().transform(value => value?.trim() || undefined),
  FISH_AUDIO_DEFAULT_VOICE_ID: z.string().optional(),
  FISH_AUDIO_MODEL: z.enum(['s1', 's2-pro', 's2.1-pro-free']).default('s2.1-pro-free'),
  FISH_AUDIO_TIMEOUT_MS: z.string().default('8000').transform(Number),
  FISH_AUDIO_MAX_ATTEMPTS: z.string().default('2').transform(Number),
  CARTESIA_API_KEY: z.string().optional().transform(value => value?.trim() || undefined),
  CARTESIA_MODEL: z.string().default('sonic-3.5'),
  CARTESIA_VERSION: z.literal('2026-03-01').default('2026-03-01'),
  CARTESIA_DEFAULT_VOICE_ID: z.string().default('779673f3-895f-4935-b6b5-b031dc78b319'),
  CARTESIA_TIMEOUT_MS: z.string().default('5000').transform(Number),
  CARTESIA_MAX_ATTEMPTS: z.string().default('2').transform(Number),
  VOICE_WEBHOOK_SECRET: z.string().min(24),
  VOICE_AUDIO_TTL_SECONDS: z.string().default('600').transform(Number),
  VOICE_MAX_UTTERANCE_SECONDS: z.string().default('30').transform(Number),
  VOICE_MAX_UPLOAD_MB: z.string().default('10').transform(Number),
  VOICE_FAST_MODEL: z.string().default('cerebras/gemma-4-31b'),
  VOICE_FAST_MAX_TOKENS: z.string().default('120').transform(Number),
  VOICE_DEEP_MODEL: z.string().default('deepseek/deepseek-v4-pro'),
  VOICE_DEEP_MAX_TOKENS: z.string().default('2400').transform(Number),
  VOICE_DEEP_TIMEOUT_MS: z.string().default('60000').transform(Number),
  ALLOW_INSECURE_VOICE_WEBHOOK: z.string().default('false').transform(value => value === 'true'),

  CLOUDFLARE_TUNNEL_MODE: z.enum(['off', 'quick', 'named']).default('off'),
  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional().transform(value => value?.trim() || undefined),

  VOXIMPLANT_ACCOUNT_ID: z.string().optional(),
  VOXIMPLANT_API_KEY: z.string().optional(),
  VOXIMPLANT_APP_NAME: z.string().default('salesagent'),
  WAZZUP24_API_KEY: z.string().optional(),
  WAZZUP24_CHANNEL_ID: z.string().optional(),
  WAZZUP24_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  AMOCRM_CLIENT_ID: z.string().optional(),
  AMOCRM_CLIENT_SECRET: z.string().optional(),
  AMOCRM_REDIRECT_URI: z.string().optional(),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET_RECORDINGS: z.string().default('recordings'),
  S3_BUCKET_KNOWLEDGE: z.string().default('knowledge'),
  S3_REGION: z.string().default('us-east-1'),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),
  RAG_MAX_CANDIDATES: z.string().default('2000').transform(Number),
  WEBHOOK_BASE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;
let cached: Env | null = null;

export function getConfig(): Env {
  if (cached) return cached;
  const input = { ...process.env };
  if (!input.MYSQL_URL && input.DATABASE_URL) input.MYSQL_URL = input.DATABASE_URL;
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment variables: ${details}`);
  }
  cached = result.data;
  return cached;
}

export const config = new Proxy({} as Env, {
  get(_target, key: string) {
    return getConfig()[key as keyof Env];
  },
});
