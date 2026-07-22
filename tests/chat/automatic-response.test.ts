import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAutomaticChatMessages } from '../../src/chat/automatic-response';

describe('automatic chat prompt history', () => {
  it('does not duplicate the WhatsApp inbound already persisted in history', () => {
    const messages = buildAutomaticChatMessages(
      [
        { role: 'user', content: 'Первый вопрос' },
        { role: 'assistant', content: 'Первый ответ' },
        { role: 'user', content: 'Текущий вопрос' },
      ],
      ' Текущий вопрос ',
      true
    );

    assert.deepEqual(messages, [
      { role: 'user', content: 'Первый вопрос' },
      { role: 'assistant', content: 'Первый ответ' },
      { role: 'user', content: 'Текущий вопрос' },
    ]);
  });

  it('keeps normal history when the current turn is not persisted yet', () => {
    const messages = buildAutomaticChatMessages(
      [{ role: 'user', content: 'Повтори' }],
      'Повтори',
      false
    );

    assert.deepEqual(messages, [
      { role: 'user', content: 'Повтори' },
      { role: 'user', content: 'Повтори' },
    ]);
  });
});
