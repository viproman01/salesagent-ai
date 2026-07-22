import winston from 'winston';
import { config } from '../config';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const SENSITIVE_FIELD = /^(?:authorization|cookie|set-cookie|password|passphrase|secret|client_?secret|access_?token|refresh_?token|api_?key|phone|email|jid|caller_?id|chat_?id|raw_?text|stack|error|err)$/iu;
const SECRET_TEXT = /(?:Bearer\s+[^\s"']+|(?:csk|sk-ant|AIza)[-_A-Za-z0-9]{12,}|(?:postgres(?:ql)?|redis):\/\/[^\s"']+)/giu;

function safeErrorCode(value: unknown): string {
  return value instanceof Error && /^[A-Za-z0-9_ -]{1,80}$/u.test(value.name)
    ? value.name
    : 'RedactedError';
}

function redactLogValue(
  key: string,
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (SENSITIVE_FIELD.test(key)) {
    return key === 'error' || key === 'err'
      ? safeErrorCode(value)
      : '[REDACTED]';
  }
  if (typeof value === 'string') return value.replace(SECRET_TEXT, '[REDACTED]');
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { code: safeErrorCode(value) };
  if (depth >= 6 || seen.has(value)) return '[REDACTED]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => redactLogValue('', item, seen, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactLogValue(childKey, childValue, seen, depth + 1);
  }
  return result;
}

export function sanitizeLogMetadata(
  input: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    sanitized[key] = redactLogValue(key, value, seen, 0);
  }
  return sanitized;
}

// Defense in depth: no caller can accidentally serialize provider headers,
// OAuth request bodies, raw model output or customer contact fields.
const redactSensitiveMeta = winston.format(info => {
  // `errors({ stack: true })` marks direct `logger.error(new Error(...))`
  // calls with a stack. Replace the arbitrary Error message as well as the
  // stack; metadata errors passed alongside a safe static message are handled
  // by sanitizeLogMetadata below.
  const directError = typeof info['stack'] === 'string';
  const sanitized = sanitizeLogMetadata(info);
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'timestamp') continue;
    info[key] = sanitized[key];
  }
  if (directError) info.message = 'RedactedError';
  return info;
})();

// Формат для разработки — читаемый вывод
const devFormat = combine(
  errors({ stack: true }),
  redactSensitiveMeta,
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

// Формат для продакшна — структурированный JSON
const prodFormat = combine(
  errors({ stack: true }),
  redactSensitiveMeta,
  timestamp(),
  json()
);

export const logger = winston.createLogger({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  format: config.NODE_ENV === 'production' ? prodFormat : devFormat,
  defaultMeta: { service: 'salesagent-ai' },
  transports: [
    new winston.transports.Console(),
    ...(config.NODE_ENV === 'production'
      ? [
          new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
          new winston.transports.File({ filename: 'logs/combined.log' }),
        ]
      : []),
  ],
});

// Дочерний логгер с контекстом (org_id, conv_id и т.д.)
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
