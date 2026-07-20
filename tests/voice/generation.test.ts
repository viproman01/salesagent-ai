import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceGenerationController } from '../../src/voice/generation';

test('starting a new turn aborts and invalidates the older generation', () => {
  const controller = new VoiceGenerationController('call-1', 'conversation-1');
  const first = controller.startTurn('turn-1');
  assert.equal(controller.isCurrent(first.turn), true);

  const second = controller.startTurn('turn-2');
  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason, 'superseded');
  assert.equal(controller.isCurrent(first.turn), false);
  assert.equal(controller.isCurrent(second.turn), true);
  assert.equal(second.turn.generation, first.turn.generation + 1);
});

test('interrupt invalidates the active generation before the next turn', () => {
  const controller = new VoiceGenerationController('call-1', 'conversation-1');
  const first = controller.startTurn('turn-1');
  controller.interrupt('barge-in');

  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason, 'barge-in');
  assert.equal(controller.isCurrent(first.turn), false);

  const next = controller.startTurn('turn-2');
  assert.ok(next.turn.generation > first.turn.generation);
  assert.equal(controller.isCurrent(next.turn), true);
});
