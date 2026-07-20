import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const EVENTS = Object.freeze({
  callAlerting: 'call-alerting',
  connected: 'connected',
  disconnected: 'disconnected',
  failed: 'failed',
  playbackFinished: 'playback-finished',
  open: 'open',
  message: 'message',
  mediaStarted: 'media-started',
  mediaEnded: 'media-ended',
  error: 'error',
  close: 'close',
});

class MockEventTarget extends EventEmitter {
  addEventListener(
    event: string,
    listener: (payload: unknown) => void
  ): void {
    this.on(event, listener);
  }

  removeEventListener(
    event: string,
    listener: (payload: unknown) => void
  ): void {
    this.off(event, listener);
  }

  dispatch(event: string, payload: unknown = {}): void {
    this.emit(event, payload);
  }
}

class MockWebSocket extends MockEventTarget {
  readonly sent: string[] = [];
  clearMediaBufferCalls = 0;
  assistantMediaRouteCalls = 0;

  send(data: string): void {
    this.sent.push(data);
  }

  sendMediaTo(): void {
    this.assistantMediaRouteCalls += 1;
  }

  stopMediaTo(): void {}

  clearMediaBuffer(): void {
    this.clearMediaBufferCalls += 1;
  }

  close(): void {}
}

class MockCall extends MockEventTarget {
  readonly spoken: string[] = [];
  stopPlaybackCalls = 0;

  id(): string {
    return 'call-vm-1';
  }

  callerid(): string {
    return '+77001234567';
  }

  answer(): void {}

  sendMediaTo(): void {}

  stopMediaTo(): void {}

  stopPlayback(): void {
    this.stopPlaybackCalls += 1;
  }

  say(text: string): void {
    this.spoken.push(text);
  }

  hangup(): void {}
}

function createScenarioHarness(): {
  call: MockCall;
  webSocket: MockWebSocket;
  dispatchControl: (message: Readonly<Record<string, unknown>>) => void;
  playbackEndedGenerations: () => number[];
} {
  const call = new MockCall();
  const webSocket = new MockWebSocket();
  const voxEngine = new MockEventTarget() as MockEventTarget & {
    createWebSocket: () => MockWebSocket;
    terminate: () => void;
  };
  voxEngine.createWebSocket = () => webSocket;
  voxEngine.terminate = () => undefined;

  const scenarioPath = resolve(process.cwd(), 'voximplant/scenario.js');
  runInNewContext(readFileSync(scenarioPath, 'utf8'), {
    __SALESAGENT_WS_URL_JSON__: 'wss://voice.example/ws/voice',
    __VOICE_ORG_ID_JSON__: 'org-vm',
    __VOICE_WS_AUTH_TOKEN_JSON__: 'token-vm',
    VoxEngine: voxEngine,
    AppEvents: {
      CallAlerting: EVENTS.callAlerting,
    },
    WebSocketEvents: {
      OPEN: EVENTS.open,
      MESSAGE: EVENTS.message,
      MEDIA_STARTED: EVENTS.mediaStarted,
      MEDIA_ENDED: EVENTS.mediaEnded,
      ERROR: EVENTS.error,
      CLOSE: EVENTS.close,
    },
    CallEvents: {
      Connected: EVENTS.connected,
      Disconnected: EVENTS.disconnected,
      Failed: EVENTS.failed,
      PlaybackFinished: EVENTS.playbackFinished,
    },
    WebSocketAudioEncoding: {
      ULAW: 'ULAW',
    },
    Language: {
      RU_RUSSIAN_FEMALE: 'RU_RUSSIAN_FEMALE',
    },
    Logger: {
      write: () => undefined,
    },
    URL,
    JSON,
    Number,
    String,
    encodeURIComponent,
  }, {
    filename: scenarioPath,
  });

  voxEngine.dispatch(EVENTS.callAlerting, { call });
  webSocket.dispatch(EVENTS.open);
  call.dispatch(EVENTS.connected);

  return {
    call,
    webSocket,
    dispatchControl: message => {
      webSocket.dispatch(EVENTS.message, {
        text: JSON.stringify(message),
      });
    },
    playbackEndedGenerations: () =>
      webSocket.sent.flatMap(frame => {
        const message = JSON.parse(frame) as Record<string, unknown>;
        return message['customEvent'] === 'playback_ended' &&
          typeof message['generation'] === 'number'
          ? [message['generation']]
          : [];
      }),
  };
}

test('suppresses delayed media clear completion', () => {
  const harness = createScenarioHarness();
  assert.equal(harness.webSocket.assistantMediaRouteCalls, 1);

  harness.dispatchControl({
    customEvent: 'playback_generation',
    generation: 1,
  });
  harness.dispatchControl({
    customEvent: 'clear_media_buffer',
    generation: 2,
  });
  harness.dispatchControl({
    customEvent: 'playback_generation',
    generation: 2,
  });

  harness.webSocket.dispatch(EVENTS.mediaEnded);
  assert.deepEqual(harness.playbackEndedGenerations(), []);

  harness.webSocket.dispatch(EVENTS.mediaEnded);
  assert.deepEqual(harness.playbackEndedGenerations(), [2]);
  assert.equal(harness.webSocket.assistantMediaRouteCalls, 1);
});

test('restores assistant media route after native fallback completion', () => {
  const harness = createScenarioHarness();
  assert.equal(harness.webSocket.assistantMediaRouteCalls, 1);

  harness.dispatchControl({
    customEvent: 'fallback_speech',
    generation: 1,
    text: 'Нативный ответ первой генерации.',
  });
  callPlaybackFinished(harness.call);

  assert.equal(harness.webSocket.assistantMediaRouteCalls, 2);
  assert.deepEqual(harness.playbackEndedGenerations(), [1]);
});

test('restores assistant media route when native fallback is cleared', () => {
  const harness = createScenarioHarness();
  assert.equal(harness.webSocket.assistantMediaRouteCalls, 1);

  harness.dispatchControl({
    customEvent: 'fallback_speech',
    generation: 2,
    text: 'Нативный ответ второй генерации.',
  });
  harness.dispatchControl({
    customEvent: 'clear_media_buffer',
    generation: 3,
  });

  assert.equal(harness.webSocket.assistantMediaRouteCalls, 2);
  assert.deepEqual(harness.playbackEndedGenerations(), []);

  harness.dispatchControl({
    customEvent: 'fallback_speech',
    generation: 3,
    text: 'Нативный ответ третьей генерации.',
  });

  callPlaybackFinished(harness.call);
  assert.equal(harness.webSocket.assistantMediaRouteCalls, 3);
  assert.deepEqual(harness.playbackEndedGenerations(), [3]);
  assert.equal(harness.webSocket.clearMediaBufferCalls, 1);
  assert.equal(harness.call.stopPlaybackCalls, 1);
  assert.deepEqual(harness.call.spoken, [
    'Нативный ответ второй генерации.',
    'Нативный ответ третьей генерации.',
  ]);
});

function callPlaybackFinished(call: MockCall): void {
  call.dispatch(EVENTS.playbackFinished);
}
