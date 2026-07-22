import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WAMessage } from 'baileys';
import {
  extractWhatsAppText,
  normalizeOutboundPhone,
  parseInboundWhatsAppMessage,
} from '../../src/whatsapp/message';

function message(value: Partial<WAMessage>): WAMessage {
  return value as WAMessage;
}

describe('WhatsApp inbound parsing', () => {
  it('extracts direct text and keeps the original reply JID', async () => {
    const parsed = await parseInboundWhatsAppMessage(
      message({
        key: {
          id: 'message-1',
          fromMe: false,
          remoteJid: '77001234567@s.whatsapp.net',
        },
        pushName: '  Aida  ',
        message: { conversation: '  Здравствуйте  ' },
      }),
      4096
    );

    assert.deepEqual(parsed, {
      messageId: 'message-1',
      phone: '77001234567',
      replyJid: '77001234567@s.whatsapp.net',
      text: 'Здравствуйте',
      pushName: 'Aida',
    });
  });

  it('unwraps ephemeral extended text', () => {
    const text = extractWhatsAppText(message({
      key: { id: 'message-2' },
      message: {
        ephemeralMessage: {
          message: {
            extendedTextMessage: { text: 'Нужна консультация' },
          },
        },
      },
    }));
    assert.equal(text, 'Нужна консультация');
  });

  it('uses a PN alternate JID for lead identity but replies to the LID', async () => {
    const parsed = await parseInboundWhatsAppMessage(
      message({
        key: {
          id: 'message-3',
          fromMe: false,
          remoteJid: '123456789012345@lid',
          remoteJidAlt: '77005554433@s.whatsapp.net',
        },
        message: { conversation: 'Цена?' },
      }),
      4096
    );

    assert.equal(parsed?.phone, '77005554433');
    assert.equal(parsed?.replyJid, '123456789012345@lid');
  });

  it('resolves an LID mapping and removes a device suffix from the PN', async () => {
    const parsed = await parseInboundWhatsAppMessage(
      message({
        key: {
          id: 'message-4',
          fromMe: false,
          remoteJid: '123456789012345@lid',
        },
        message: { conversation: 'Добрый день' },
      }),
      4096,
      async () => '77001234567:0@s.whatsapp.net'
    );

    assert.equal(parsed?.phone, '77001234567');
    assert.equal(parsed?.replyJid, '123456789012345@lid');
  });

  it('ignores own, group, status, broadcast and oversized messages', async () => {
    const variants: WAMessage[] = [
      message({
        key: { id: 'own', fromMe: true, remoteJid: '7700@s.whatsapp.net' },
        message: { conversation: 'own' },
      }),
      message({
        key: { id: 'group', fromMe: false, remoteJid: '1-2@g.us' },
        message: { conversation: 'group' },
      }),
      message({
        key: { id: 'status', fromMe: false, remoteJid: 'status@broadcast' },
        message: { conversation: 'status' },
      }),
      message({
        key: { id: 'broadcast', fromMe: false, remoteJid: '123@broadcast' },
        message: { conversation: 'broadcast' },
      }),
      message({
        key: { id: 'large', fromMe: false, remoteJid: '7700@s.whatsapp.net' },
        message: { conversation: '12345' },
      }),
    ];

    for (const value of variants) {
      assert.equal(await parseInboundWhatsAppMessage(value, 4), null);
    }
  });
});

describe('WhatsApp outbound phone validation', () => {
  it('normalizes a valid phone and rejects short or overlong values', () => {
    assert.equal(normalizeOutboundPhone('+7 (700) 123-45-67'), '77001234567');
    assert.equal(normalizeOutboundPhone('123'), null);
    assert.equal(normalizeOutboundPhone('1'.repeat(16)), null);
  });
});
