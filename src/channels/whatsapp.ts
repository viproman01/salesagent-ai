import { createHash } from 'node:crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { WhatsAppBridge } from '../whatsapp/bridge';
import type { ParsedWhatsAppMessage } from '../whatsapp/message';
import {
  claimWhatsAppMessage,
  completeWhatsAppMessage,
  failWhatsAppMessage,
} from '../whatsapp/receipts';

export async function processWhatsAppBridgeMessage(
  orgId: string,
  message: ParsedWhatsAppMessage
): Promise<void> {
  const claimed = await claimWhatsAppMessage(orgId, message.messageId);
  if (!claimed) {
    logger.debug('Duplicate WhatsApp message ignored', {
      orgId,
      messageId: message.messageId,
    });
    return;
  }

  try {
    const { processIncomingMessage } = await import(
      '../orchestrator/session-manager.js'
    );
    await processIncomingMessage({
      channel: 'whatsapp',
      orgId,
      phone: message.phone,
      text: message.text,
      externalId: message.messageId,
      metadata: {
        whatsappJid: message.replyJid,
        whatsappPushName: message.pushName,
      },
    });
    await completeWhatsAppMessage(orgId, message.messageId);
  } catch (error) {
    await failWhatsAppMessage(orgId, message.messageId).catch(markError => {
      logger.error('Failed to mark WhatsApp receipt as failed', {
        orgId,
        messageId: message.messageId,
        code: markError instanceof Error ? markError.name : 'UnknownError',
      });
    });
    throw error;
  }
}

export const whatsappBridge = new WhatsAppBridge({
  authRoot: config.WHATSAPP_AUTH_DIR,
  inboundMaxChars: config.WHATSAPP_INBOUND_MAX_CHARS,
  outboundMaxChars: config.WHATSAPP_OUTBOUND_MAX_CHARS,
  reconnectBaseDelayMs: config.WHATSAPP_RECONNECT_BASE_DELAY_MS,
  reconnectMaxDelayMs: config.WHATSAPP_RECONNECT_MAX_DELAY_MS,
  onIncomingMessage: processWhatsAppBridgeMessage,
});

export async function initializeWhatsAppBridge(): Promise<void> {
  if (!config.WHATSAPP_AUTO_START) {
    logger.info('WhatsApp session auto-restore disabled');
    return;
  }
  await whatsappBridge.restorePersistedSessions();
}

export async function shutdownWhatsAppBridge(): Promise<void> {
  await whatsappBridge.shutdown();
}

export async function sendWhatsAppMessage(
  orgId: string,
  phone: string,
  text: string,
  replyJid: string,
  idempotencyKey?: string
): Promise<string> {
  const messageId = idempotencyKey
    ? createHash('sha256')
        .update(`${orgId}:${idempotencyKey}`)
        .digest('hex')
        .slice(0, 24)
        .toUpperCase()
    : undefined;
  return whatsappBridge.sendMessage(orgId, phone, text, replyJid, messageId);
}
