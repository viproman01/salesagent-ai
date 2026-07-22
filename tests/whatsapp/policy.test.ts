import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyWhatsAppControlCommand,
  ensureAiDisclosure,
  WHATSAPP_CONTROL_REPLIES,
} from '../../src/whatsapp/policy';

describe('WhatsApp automation policy', () => {
  it('recognizes explicit STOP, START and human handoff commands', () => {
    assert.equal(classifyWhatsAppControlCommand('  STOP!!! '), 'stop');
    assert.equal(classifyWhatsAppControlCommand('СтОп'), 'stop');
    assert.equal(classifyWhatsAppControlCommand('не пишите.'), 'stop');
    assert.equal(classifyWhatsAppControlCommand('/stop'), 'stop');
    assert.equal(classifyWhatsAppControlCommand('STOP please'), 'stop');
    assert.equal(classifyWhatsAppControlCommand('stop пожалуйста'), 'stop');
    assert.equal(classifyWhatsAppControlCommand('не пишите мне больше'), 'stop');
    assert.equal(
      classifyWhatsAppControlCommand('Пожалуйста не пишите нам больше!'),
      'stop'
    );
    assert.equal(classifyWhatsAppControlCommand(' СТАРТ '), 'start');
    assert.equal(classifyWhatsAppControlCommand('позовите оператора'), 'human');
    assert.equal(classifyWhatsAppControlCommand('хочу поговорить с человеком'), 'human');
  });

  it('does not trigger control state from ordinary questions', () => {
    assert.equal(classifyWhatsAppControlCommand('Как работает оператор?'), null);
    assert.equal(classifyWhatsAppControlCommand('Не пишите цену без скидки'), null);
    assert.equal(classifyWhatsAppControlCommand('STOP продажи не должны'), null);
    assert.equal(classifyWhatsAppControlCommand('Старт продаж завтра'), null);
  });

  it('deterministically discloses AI on the first generated reply', () => {
    assert.equal(
      ensureAiDisclosure('Я обычный менеджер. Чем помочь?', true),
      'Я AI-ассистент компании. Я обычный менеджер. Чем помочь?'
    );
    assert.equal(
      ensureAiDisclosure('Я виртуальный помощник компании.', true),
      'Я виртуальный помощник компании.'
    );
    assert.equal(
      ensureAiDisclosure('Повторный ответ.', false),
      'Повторный ответ.'
    );
    for (const reply of Object.values(WHATSAPP_CONTROL_REPLIES)) {
      assert.match(reply, /AI-ассистент/u);
    }
  });
});
