import axios from 'axios';
import type { Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { processIncomingMessage } from '../orchestrator/session-manager';
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from '../integrations/webhook-events';

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
  const orgId = String(req.params['orgId'] ?? '');

  const msg    = update.message;
  const chatId = String(msg.chat.id);
  const text   = msg.text ?? '';

  logger.info('Telegram message received', { chatId, messageId: msg.message_id });

  processTelegramMessage(orgId, chatId, text, update).catch(err => {
    logger.error('Telegram processing error', { error: err, chatId });
  });
}

async function processTelegramMessage(
  orgId: string,
  chatId: string,
  text: string,
  update: TelegramUpdate
): Promise<void> {
  const eventId = String(update.update_id);
  if (!(await claimWebhookEvent('telegram', orgId, eventId))) return;
  const message = update.message!;
  try {
    await processIncomingMessage({
      channel: 'telegram',
      phone: chatId,
      text,
      externalId: String(message.message_id),
      orgId,
      metadata: {
        telegramChatId: chatId,
        firstName: message.from.first_name,
        username: message.from.username,
      },
    });
    await completeWebhookEvent('telegram', eventId);
  } catch (error) {
    await failWebhookEvent('telegram', eventId, error);
    throw error;
  }
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
