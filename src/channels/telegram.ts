import axios from 'axios';
import type { Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { processIncomingMessage } from '../orchestrator/session-manager';

const TG_BASE = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN ?? 'NOTSET'}`;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number };
    text?: string;
    contact?: { phone_number: string };
    date: number;
  };
}

/**
 * Webhook-обработчик обновлений Telegram
 * POST /api/webhooks/telegram
 */
export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  const update = req.body as TelegramUpdate;
  if (!update.message?.text) return;

  const msg    = update.message;
  const chatId = String(msg.chat.id);
  const text   = msg.text ?? '';

  logger.info('Telegram message received', { chatId, messageId: msg.message_id });

  processIncomingMessage({
    channel:    'telegram',
    phone:      chatId, // используем chat_id как идентификатор
    text,
    externalId: String(msg.message_id),
    metadata:   {
      telegramChatId: chatId,
      firstName:      msg.from.first_name,
      username:       msg.from.username,
    },
  }).catch(err => {
    logger.error('Telegram processing error', { error: err, chatId });
  });
}

/**
 * Отправить сообщение через Telegram Bot API
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.warn('Telegram bot token not configured');
    return;
  }

  await axios.post(
    `${TG_BASE}/sendMessage`,
    {
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
    },
    { timeout: 5000 }
  );
  logger.debug('Telegram message sent', { chatId, textLength: text.length });
}

/**
 * Зарегистрировать webhook в Telegram
 */
export async function registerTelegramWebhook(webhookUrl: string): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) return;

  await axios.post(`${TG_BASE}/setWebhook`, {
    url:             webhookUrl,
    secret_token:    config.TELEGRAM_WEBHOOK_SECRET ?? '',
    allowed_updates: ['message'],
  });
  logger.info('Telegram webhook registered', { webhookUrl });
}
