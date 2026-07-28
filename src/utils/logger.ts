import winston from 'winston';
import { config } from '../config';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// Формат для разработки — читаемый вывод
const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

// Формат для продакшна — структурированный JSON
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

export const logger = winston.createLogger({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  format: config.NODE_ENV === 'production' ? prodFormat : devFormat,
  defaultMeta: { service: 'salesagent-ai' },
  // Pterodactyl captures stdout/stderr. File transports without rotation would
  // grow indefinitely and eventually consume the server allocation.
  transports: [new winston.transports.Console()],
});

// Дочерний логгер с контекстом (org_id, conv_id и т.д.)
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
