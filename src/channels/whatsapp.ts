import axios from 'axios';
import type { Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { processIncomingMessage } from '../orchestrator/session-manager';
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent } from '../integrations/webhook-events';

const WAZZUP_BASE = 'https://api.wazzup24.com/v3';

interface Wazzup24Webhook {
  messages?: Array<{
    messageId: string;
    chatType: string;
    chatId:   string;
    text?:    string;
    type:     string;
    timestamp: number;
  }>;
}

/**
 * Webhook-обработчик входящих сообщений WhatsApp (Wazzup24)
 * POST /api/webhooks/whatsapp
 */
export async function handleWhatsAppWebhook(req: Request, res: Response): Promise<void> {
  // Быстро отвечаем 200 — Wazzup ждёт ответ в течение 5 секунд
  res.status(200).json({ ok: true });

  const body = req.body as Wazzup24Webhook;
  if (!body.messages) return;
  const orgId = String(req.params['orgId'] ?? '');

  for (const msg of body.messages) {
    if (msg.type !== 'text' || !msg.text) continue;

    const phone = msg.chatId.replace('@c.us', '').replace(/\D/g, '');
    logger.info('WhatsApp message received', { phone, messageId: msg.messageId });

    processWhatsAppMessage(orgId, phone, msg.text, msg.messageId).catch(err => {
      logger.error('WhatsApp processing error', { error: err, phone });
    });
  }
}

async function processWhatsAppMessage(orgId: string, phone: string, text: string, eventId: string): Promise<void> {
  if (!(await claimWebhookEvent('whatsapp', orgId, eventId))) return;
  try {
    await processIncomingMessage({
      channel:    'whatsapp',
      phone,
      text,
      externalId: eventId,
      orgId,
    });
    await completeWebhookEvent('whatsapp', eventId);
  } catch (error) {
    await failWebhookEvent('whatsapp', eventId, error);
    throw error;
  }
}

/**
 * Отправить сообщение через Wazzup24 API
 */
export async function sendWhatsAppMessage(phone: string, text: string): Promise<void> {
  if (!config.WAZZUP24_API_KEY || !config.WAZZUP24_CHANNEL_ID) {
    logger.warn('Wazzup24 not configured, skipping send');
    return;
  }

  const normalizedPhone = phone.replace(/\D/g, '');
  await axios.post(
    `${WAZZUP_BASE}/message`,
    {
      channelId: config.WAZZUP24_CHANNEL_ID,
      chatType:  'whatsapp',
      chatId:    `${normalizedPhone}@c.us`,
      text,
    },
    {
      headers: {
        Authorization: `Bearer ${config.WAZZUP24_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }
  );
  logger.debug('WhatsApp message sent', { phone: normalizedPhone, textLength: text.length });
}

/**
 * Зарегистрировать webhook URL в Wazzup24
 */
export async function registerWebhook(webhookUrl: string): Promise<void> {
  if (!config.WAZZUP24_API_KEY) return;

  await axios.post(
    `${WAZZUP_BASE}/webhooks`,
    { webhooksUri: webhookUrl },
    {
      headers: { Authorization: `Bearer ${config.WAZZUP24_API_KEY}` },
    }
  );
  logger.info('Wazzup24 webhook registered', { webhookUrl });
}
