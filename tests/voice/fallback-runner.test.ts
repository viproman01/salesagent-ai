import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FallbackModelRunner } from '../../src/voice/models/fallback-runner';
import type {
  ModelCandidate,
  ModelRunner,
  ModelRunnerRequest,
} from '../../src/voice/orchestrator';

const CANDIDATE: ModelCandidate = Object.freeze({
  segments: Object.freeze([]),
  confidence: 0.8,
  safeToCommit: true,
});

function request(
  signal: AbortSignal,
  deadlineAtMs = 1_000
): ModelRunnerRequest {
  return {
    tier: 'fast',
    prompt: 'test prompt',
    turn: {
      callId: 'call-1',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      generation: 1,
    },
    signal,
    deadlineAtMs,
  };
}

function runner(
  name: string,
  run: ModelRunner['run']
): ModelRunner {
  return { name, run };
}

describe('FallbackModelRunner', () => {
  it('returns the primary candidate without invoking the fallback', async () => {
    let fallbackCalls = 0;
    const composed = new FallbackModelRunner({
      primary: runner('primary', async () => CANDIDATE),
      fallback: runner('fallback', async () => {
        fallbackCalls++;
        return CANDIDATE;
      }),
      now: () => 100,
    });

    assert.equal(composed.name, 'primary->fallback');
    assert.equal(
      await composed.run(request(new AbortController().signal)),
      CANDIDATE
    );
    assert.equal(fallbackCalls, 0);
  });

  it('uses the fallback after a primary provider failure', async () => {
    const failure = new Error('primary unavailable');
    const controller = new AbortController();
    const originalRequest = request(controller.signal);
    let received: ModelRunnerRequest | undefined;
    let observed: unknown;
    const composed = new FallbackModelRunner({
      primary: runner('primary', async () => {
        throw failure;
      }),
      fallback: runner('fallback', async value => {
        received = value;
        return CANDIDATE;
      }),
      now: () => 100,
      onFallback: error => {
        observed = error;
      },
    });

    assert.equal(await composed.run(originalRequest), CANDIDATE);
    assert.equal(received, originalRequest);
    assert.equal(observed, failure);
  });

  it('does not start fallback work after cancellation', async () => {
    const controller = new AbortController();
    const failure = new Error('cancelled');
    let fallbackCalls = 0;
    const composed = new FallbackModelRunner({
      primary: runner('primary', async () => {
        controller.abort();
        throw failure;
      }),
      fallback: runner('fallback', async () => {
        fallbackCalls++;
        return CANDIDATE;
      }),
      now: () => 100,
    });

    await assert.rejects(composed.run(request(controller.signal)), failure);
    assert.equal(fallbackCalls, 0);
  });

  it('does not start fallback work after the tier deadline', async () => {
    const failure = new Error('deadline exceeded');
    let fallbackCalls = 0;
    const composed = new FallbackModelRunner({
      primary: runner('primary', async () => {
        throw failure;
      }),
      fallback: runner('fallback', async () => {
        fallbackCalls++;
        return CANDIDATE;
      }),
      now: () => 1_000,
    });

    await assert.rejects(
      composed.run(request(new AbortController().signal, 1_000)),
      failure
    );
    assert.equal(fallbackCalls, 0);
  });
});
