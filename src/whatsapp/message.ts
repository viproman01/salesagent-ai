import type { WAMessage } from 'baileys';

export interface ParsedWhatsAppMessage {
  messageId: string;
  phone: string;
  replyJid: string;
  text: string;
  pushName?: string;
}

type MessageContent = Record<string, unknown>;

const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
] as const;

export function isDirectWhatsAppJid(jid: string): boolean {
  return (
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@lid') ||
    jid.endsWith('@hosted') ||
    jid.endsWith('@hosted.lid')
  );
}

export function phoneFromWhatsAppJid(jid: string): string | null {
  const user = jid.split('@', 1)[0]?.split(':', 1)[0] ?? '';
  const digits = user.replace(/\D/g, '');
  return digits.length > 0 && digits.length <= 30 ? digits : null;
}

export function normalizeOutboundPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15 ? digits : null;
}

function asRecord(value: unknown): MessageContent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as MessageContent;
}

function unwrapContent(value: unknown): MessageContent | undefined {
  let current = asRecord(value);

  for (let depth = 0; current && depth < 6; depth += 1) {
    let nested: MessageContent | undefined;
    for (const key of WRAPPER_KEYS) {
      const wrapper = asRecord(current[key]);
      const message = asRecord(wrapper?.['message']);
      if (message) {
        nested = message;
        break;
      }
    }
    if (!nested) return current;
    current = nested;
  }

  return current;
}

export function extractWhatsAppText(message: WAMessage): string | null {
  const content = unwrapContent(message.message);
  if (!content) return null;

  const conversation = content['conversation'];
  const extendedText = asRecord(content['extendedTextMessage'])?.['text'];
  const text = typeof conversation === 'string'
    ? conversation
    : typeof extendedText === 'string'
      ? extendedText
      : null;

  const trimmed = text?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export async function parseInboundWhatsAppMessage(
  message: WAMessage,
  maxChars: number,
  getPhoneForLid?: (lid: string) => Promise<string | null>
): Promise<ParsedWhatsAppMessage | null> {
  if (message.key.fromMe) return null;

  const replyJid = message.key.remoteJid ?? '';
  if (!isDirectWhatsAppJid(replyJid)) return null;

  const messageId = message.key.id ?? '';
  if (messageId.length === 0 || messageId.length > 255) return null;

  const text = extractWhatsAppText(message);
  if (!text || text.length > maxChars) return null;

  const altJid = message.key.remoteJidAlt;
  let identityJid = altJid && altJid.endsWith('@s.whatsapp.net')
    ? altJid
    : replyJid.endsWith('@s.whatsapp.net')
      ? replyJid
      : null;

  if (!identityJid && replyJid.endsWith('@lid') && getPhoneForLid) {
    try {
      identityJid = await getPhoneForLid(replyJid);
    } catch {
      // A missing/stale LID mapping is non-fatal. The stable LID remains the
      // lead identity and the original JID remains the reply destination.
    }
  }

  const phone = phoneFromWhatsAppJid(identityJid ?? replyJid);
  if (!phone) return null;

  const pushName = typeof message.pushName === 'string'
    ? message.pushName.trim() || undefined
    : undefined;

  return { messageId, phone, replyJid, text, pushName };
}
