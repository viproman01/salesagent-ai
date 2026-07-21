import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const commaSeparatedSecrets = z.preprocess(
  emptyStringAsUndefined,
  z.string()
    .refine(
      value => value.split(',').every(secret => secret.trim().length > 0),
      'Comma-separated secrets must not contain empty entries'
    )
    .transform(
      (value): readonly string[] =>
        Object.freeze([
          ...new Set(value.split(',').map(secret => secret.trim())),
        ])
    )
    .optional()
);

// Схема валидации всех переменных окружения
const envSchema = z.object({
  NODE_ENV:      z.enum(['development', 'production', 'test']).default('development'),
  PORT:          z.string().default('3000').transform(Number),
  API_BASE_URL:  z.string().default('http://localhost:3000'),
  FRONTEND_URL:  z.string().default('http://localhost:5173'),

  // JWT
  JWT_SECRET:     z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Database
  DATABASE_URL: z.string(),

  // Redis
  REDIS_URL:      z.string().default('redis://localhost:6379'),
  REDIS_PASSWORD: z.string().optional(),

  // Anthropic Claude
  ANTHROPIC_API_KEY: z.string(),

  // Cerebras Inference (optional fast voice lane)
  CEREBRAS_API_KEYS:          commaSeparatedSecrets,

  // Google Gemini
  GOOGLE_API_KEY:       z.string(),
  GEMINI_LIVE_MODEL:    z.string().default('gemini-3.1-flash-live-preview'),
  GEMINI_EMBED_MODEL:   z.string().default('text-embedding-004'),

  // Fish Audio (опциональный новый TTS runtime)
  FISH_API_KEY:                z.string().optional(),
  FISH_TTS_URL:                z.string().url()
    .refine(value => value.startsWith('wss://'), 'Fish TTS URL must use wss://')
    .default('wss://api.fish.audio/v1/tts/live'),
  FISH_TTS_ALLOW_CUSTOM_ENDPOINT: z.enum(['true', 'false'])
    .default('false')
    .transform(value => value === 'true'),
  FISH_TTS_MODEL:              z.string().default('s2-pro'),
  FISH_TTS_REFERENCE_ID:       z.string().optional(),
  FISH_TTS_LATENCY:            z.enum(['low', 'balanced', 'normal']).default('balanced'),
  FISH_TTS_SAMPLE_RATE:        z.coerce.number().int().positive().default(8000),
  FISH_TTS_CHUNK_LENGTH:       z.coerce.number().int().min(100).max(300).default(100),
  FISH_TTS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  FISH_TTS_FIRST_AUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  FISH_TTS_FINISH_TIMEOUT_MS:  z.coerce.number().int().positive().default(10000),

  // Новый full-duplex voice pipeline
  VOICE_RUNTIME:               z.enum(['gemini', 'pipeline']).default('gemini'),
  VOICE_DEFAULT_ORG_ID:        z.preprocess(
    emptyStringAsUndefined,
    z.string().uuid().optional()
  ),
  VOICE_WS_AUTH_TOKEN:         z.preprocess(
    emptyStringAsUndefined,
    z.string().min(32).optional()
  ),
  VOICE_ENDPOINTING_DELAY_MS:  z.coerce.number().int().min(0).max(2000).default(0),
  VOICE_SAFE_DRAFT:            z.string().min(1).max(160).default('Секунду, уточняю.'),
  VOICE_GREETING_TEXT:         z.string().min(1).max(300).default('Здравствуйте! Я виртуальный помощник компании. Чем могу помочь?'),
  VOICE_PLAYBACK_DRAIN_PADDING_MS: z.coerce.number().int().min(0).max(2000).default(160),
  VOICE_WS_MAX_PAYLOAD_BYTES:  z.coerce.number().int().min(1024).max(1024 * 1024).default(128 * 1024),
  VOICE_WS_MAX_BUFFERED_BYTES: z.coerce.number().int().min(16 * 1024).max(16 * 1024 * 1024).default(128 * 1024),
  VOICE_RECORDING_MAX_BYTES:   z.coerce.number().int().min(1024 * 1024).max(1024 * 1024 * 1024).default(64 * 1024 * 1024),
  VOICE_LLM_FAST_PROVIDER:     z.enum(['anthropic', 'cerebras']).default('anthropic'),
  VOICE_LLM_FAST_MODEL:        z.string().default('claude-haiku-4-5-20251001'),
  VOICE_LLM_CEREBRAS_MODEL:    z.string().default('gemma-4-31b'),
  VOICE_LLM_MEDIUM_MODEL:      z.string().default('claude-sonnet-5'),
  VOICE_LLM_DEEP_MODEL:        z.string().default('claude-opus-4-8'),
  VOICE_LLM_FAST_TIMEOUT_MS:   z.coerce.number().int().positive().default(600),
  VOICE_LLM_CEREBRAS_FAST_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  VOICE_LLM_MEDIUM_TIMEOUT_MS: z.coerce.number().int().positive().default(1800),
  VOICE_LLM_DEEP_TIMEOUT_MS:   z.coerce.number().int().positive().default(4000),
  VOICE_LLM_TOTAL_TIMEOUT_MS:  z.coerce.number().int().positive().default(5000),

  // Deepgram Flux streaming STT
  DEEPGRAM_API_KEY:             z.string().optional(),
  DEEPGRAM_STT_URL:             z.string().url()
    .refine(value => value.startsWith('wss://'), 'Deepgram STT URL must use wss://')
    .default('wss://api.deepgram.com/v2/listen'),
  DEEPGRAM_STT_ALLOW_CUSTOM_ENDPOINT: z.enum(['true', 'false'])
    .default('false')
    .transform(value => value === 'true'),
  DEEPGRAM_STT_MODEL:           z.literal('flux-general-multi').default('flux-general-multi'),
  DEEPGRAM_STT_LANGUAGE_HINT:   z.string().default('ru'),
  DEEPGRAM_STT_EOT_THRESHOLD:   z.coerce.number().min(0.5).max(0.9).default(0.7),
  DEEPGRAM_STT_EOT_TIMEOUT_MS:  z.coerce.number().int().min(500).max(10000).default(1800),
  DEEPGRAM_STT_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  DEEPGRAM_STT_FINISH_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // AssemblyAI Whisper Streaming — cold fallback для ru/kk
  ASSEMBLYAI_API_KEY:           z.string().optional(),
  ASSEMBLYAI_STT_URL:           z.string().url()
    .refine(value => value.startsWith('wss://'), 'AssemblyAI STT URL must use wss://')
    .default('wss://streaming.assemblyai.com/v3/ws'),
  ASSEMBLYAI_STT_ALLOW_CUSTOM_ENDPOINT: z.enum(['true', 'false'])
    .default('false')
    .transform(value => value === 'true'),
  ASSEMBLYAI_STT_MODEL:         z.literal('whisper-rt').default('whisper-rt'),
  ASSEMBLYAI_STT_MIN_TURN_SILENCE_MS: z.coerce.number().int().min(80).max(6000).default(400),
  ASSEMBLYAI_STT_MAX_TURN_SILENCE_MS: z.coerce.number().int().min(80).max(10000).default(1280),
  ASSEMBLYAI_STT_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  ASSEMBLYAI_STT_FINISH_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  ASSEMBLYAI_STT_FORCE_ENDPOINT_TIMEOUT_MS: z.coerce.number().int().positive().default(750),

  // Voximplant (телефония)
  VOXIMPLANT_ACCOUNT_ID: z.string().optional(),
  VOXIMPLANT_API_KEY:    z.string().optional(),
  VOXIMPLANT_APP_NAME:   z.string().default('salesagent'),

  // Wazzup24 (WhatsApp)
  WAZZUP24_API_KEY:       z.string().optional(),
  WAZZUP24_CHANNEL_ID:    z.string().optional(),
  WAZZUP24_WEBHOOK_SECRET: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN:       z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET:  z.string().optional(),

  // AmoCRM
  AMOCRM_CLIENT_ID:     z.string().optional(),
  AMOCRM_CLIENT_SECRET: z.string().optional(),
  AMOCRM_REDIRECT_URI:  z.string().optional(),

  // S3 / MinIO
  S3_ENDPOINT:           z.string().default('http://localhost:9000'),
  S3_ACCESS_KEY:         z.string().default('minioadmin'),
  S3_SECRET_KEY:         z.string().default('minioadmin'),
  S3_BUCKET_RECORDINGS:  z.string().default('recordings'),
  S3_BUCKET_KNOWLEDGE:   z.string().default('knowledge'),
  S3_REGION:             z.string().default('us-east-1'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS:    z.string().default('60000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),

  // Webhook base URL
  WEBHOOK_BASE_URL: z.string().optional(),
}).superRefine((env, ctx) => {
  if (
    env.ASSEMBLYAI_STT_MAX_TURN_SILENCE_MS <
    env.ASSEMBLYAI_STT_MIN_TURN_SILENCE_MS
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ASSEMBLYAI_STT_MAX_TURN_SILENCE_MS'],
      message:
        'ASSEMBLYAI_STT_MAX_TURN_SILENCE_MS must be greater than or equal to ASSEMBLYAI_STT_MIN_TURN_SILENCE_MS',
    });
  }
  if (
    env.ASSEMBLYAI_STT_FORCE_ENDPOINT_TIMEOUT_MS >=
    env.ASSEMBLYAI_STT_FINISH_TIMEOUT_MS
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ASSEMBLYAI_STT_FORCE_ENDPOINT_TIMEOUT_MS'],
      message:
        'ASSEMBLYAI_STT_FORCE_ENDPOINT_TIMEOUT_MS must be less than ASSEMBLYAI_STT_FINISH_TIMEOUT_MS',
    });
  }

  if (env.VOICE_RUNTIME !== 'pipeline') return;

  const required: Array<[keyof typeof env, unknown]> = [
    ['DEEPGRAM_API_KEY', env.DEEPGRAM_API_KEY],
    ['FISH_API_KEY', env.FISH_API_KEY],
    ['FISH_TTS_REFERENCE_ID', env.FISH_TTS_REFERENCE_ID],
    ['VOICE_DEFAULT_ORG_ID', env.VOICE_DEFAULT_ORG_ID],
    ['VOICE_WS_AUTH_TOKEN', env.VOICE_WS_AUTH_TOKEN],
  ];
  for (const [key, value] of required) {
    if (!value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${String(key)} is required when VOICE_RUNTIME=pipeline`,
      });
    }
  }

  if (
    env.VOICE_LLM_FAST_PROVIDER === 'cerebras' &&
    !env.CEREBRAS_API_KEYS?.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CEREBRAS_API_KEYS'],
      message:
        'CEREBRAS_API_KEYS is required when VOICE_RUNTIME=pipeline and VOICE_LLM_FAST_PROVIDER=cerebras',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/** Parse an explicit environment object without touching the cached process config. */
export function parseConfigEnvironment(
  environment: NodeJS.ProcessEnv
): Env {
  return envSchema.parse(environment);
}

export function resolveVoiceFastTimeoutMs(
  environment: Pick<
    Env,
    | 'VOICE_LLM_FAST_PROVIDER'
    | 'VOICE_LLM_FAST_TIMEOUT_MS'
    | 'VOICE_LLM_CEREBRAS_FAST_TIMEOUT_MS'
  >
): number {
  return environment.VOICE_LLM_FAST_PROVIDER === 'cerebras'
    ? environment.VOICE_LLM_CEREBRAS_FAST_TIMEOUT_MS
    : environment.VOICE_LLM_FAST_TIMEOUT_MS;
}

let _config: Env | null = null;

export function getConfig(): Env {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    result.error.issues.forEach(issue => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    // В продакшне — завершаем процесс, в тестах — выбрасываем
    if (process.env.NODE_ENV !== 'test') {
      process.exit(1);
    }
    throw new Error('Invalid environment variables');
  }
  _config = result.data;
  return _config;
}

export const config = new Proxy({} as Env, {
  get(_, key: string) {
    return getConfig()[key as keyof Env];
  },
});
