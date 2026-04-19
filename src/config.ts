import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

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

  // Google Gemini
  GOOGLE_API_KEY:       z.string(),
  GEMINI_LIVE_MODEL:    z.string().default('gemini-3.1-flash-live-preview'),
  GEMINI_EMBED_MODEL:   z.string().default('text-embedding-004'),

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
});

type Env = z.infer<typeof envSchema>;

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
