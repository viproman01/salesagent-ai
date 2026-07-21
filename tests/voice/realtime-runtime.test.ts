import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { decode, encode } from '@msgpack/msgpack';
import WebSocket from 'ws';
import {
  VoiceResponseOrchestrator,
  type ModelCandidate,
  type ModelRunner,
  type ModelRunnerRequest,
} from '../../src/voice/orchestrator';
import type {
  SttSessionEvent,
  SttSessionOptions,
  SttTerminal,
  StreamingSttProvider,
  StreamingSttSession,
} from '../../src/voice/providers/stt';
import type {
  CommittedSpeechSegment,
  StreamingTtsProvider,
  StreamingTtsSession,
  TtsSessionOptions,
  TtsTerminal,
} from '../../src/voice/providers/tts';
import { FishTtsProvider } from '../../src/voice/providers/fish-tts';
import { RealtimeVoiceRuntime } from '../../src/voice/realtime-runtime';
import type { VoiceRuntimeEvent } from '../../src/voice/runtime';

const COMPLETED_STT: SttTerminal = Object.freeze({
  status: 'completed',
  audioBytes: 0,
  audioFrames: 0,
  turnsCompleted: 0,
  totalMs: 0,
});

const COMPLETED_TTS: TtsTerminal = Object.freeze({
  status: 'completed',
  audioBytes: 16_000,
  audioChunks: 1,
  totalMs: 1,
});

class FakeSttSession implements StreamingSttSession {
  readonly provider = 'fake-stt';
  readonly transcriptionId = 'transcription-1';
  readonly attemptId = 'attempt-1';
  readonly stream;
  private _state: StreamingSttSession['state'] = 'open';
  readonly closed: Promise<SttTerminal>;
  private resolveClosed!: (terminal: SttTerminal) => void;

  constructor(options: SttSessionOptions) {
    this.stream = options.stream;
    this.closed = new Promise(resolve => {
      this.resolveClosed = resolve;
    });
  }

  get state(): StreamingSttSession['state'] {
    return this._state;
  }

  async writeAudio(_audio: Buffer): Promise<void> {}

  async finish(): Promise<SttTerminal> {
    if (this._state === 'open') {
      this._state = 'completed';
      this.resolveClosed(COMPLETED_STT);
    }
    return COMPLETED_STT;
  }
}

class FakeSttProvider implements StreamingSttProvider {
  readonly name = 'fake-stt';
  readonly inputFormat = Object.freeze({
    encoding: 'mulaw' as const,
    sampleRateHz: 8000 as const,
    channels: 1 as const,
  });
  session?: FakeSttSession;
  onEvent?: (event: SttSessionEvent) => void | Promise<void>;

  async open(options: SttSessionOptions): Promise<StreamingSttSession> {
    this.onEvent = options.onEvent;
    this.session = new FakeSttSession(options);
    return this.session;
  }
}

function fakeSttTurnEvent(
  kind: 'update' | 'start_of_turn',
  transcript: string,
  serverSequence: number
): SttSessionEvent {
  return {
    type: 'turn',
    transcriptionId: 'transcription-1',
    attemptId: 'attempt-1',
    provider: 'fake-stt',
    stream: {
      callId: 'call-greeting-update',
      conversationId: 'conversation-greeting-update',
    },
    timestampMs: Date.now(),
    signal: new AbortController().signal,
    turn: {
      kind,
      turnIndex: 0,
      transcript,
      words: [],
      audioWindowStartMs: 0,
      audioWindowEndMs: 240,
      endOfTurnConfidence: 0.1,
      isFinal: false,
      isSpeculative: false,
      requestId: 'request-1',
      serverSequence,
      languages: [],
      languagesHinted: ['ru'],
    },
  };
}

class FakeTtsSession implements StreamingTtsSession {
  readonly provider = 'fake-tts';
  readonly synthesisId: string;
  readonly attemptId: string;
  readonly turn;
  private _state: StreamingTtsSession['state'] = 'open';
  readonly closed: Promise<TtsTerminal>;
  private resolveClosed!: (terminal: TtsTerminal) => void;
  private sequence = 0;
  private emitted = false;

  constructor(
    private readonly options: TtsSessionOptions,
    id: number
  ) {
    this.synthesisId = `synthesis-${id}`;
    this.attemptId = `attempt-${id}`;
    this.turn = options.turn;
    this.closed = new Promise(resolve => {
      this.resolveClosed = resolve;
    });
    if (options.signal.aborted) {
      this.cancel();
    } else {
      options.signal.addEventListener('abort', () => this.cancel(), {
        once: true,
      });
    }
  }

  get state(): StreamingTtsSession['state'] {
    return this._state;
  }

  async write(_segment: CommittedSpeechSegment): Promise<void> {
    if (this._state !== 'open') throw new Error('cancelled');
  }

  async flush(): Promise<void> {
    if (this._state !== 'open') throw new Error('cancelled');
    if (this.emitted) return;
    this.emitted = true;
    await this.options.onEvent({
      type: 'audio',
      synthesisId: this.synthesisId,
      attemptId: this.attemptId,
      provider: this.provider,
      turn: this.turn,
      timestampMs: Date.now(),
      signal: this.options.signal,
      sequence: this.sequence++,
      data: Buffer.alloc(16_000),
      format: {
        encoding: 'pcm_s16',
        sampleRateHz: 8000,
        channels: 1,
      },
      firstAudioMs: 1,
    });
  }

  async finish(): Promise<TtsTerminal> {
    if (this._state === 'open') {
      this._state = 'completed';
      this.resolveClosed(COMPLETED_TTS);
      return COMPLETED_TTS;
    }
    return this.closed;
  }

  private cancel(): void {
    if (this._state !== 'open') return;
    this._state = 'cancelled';
    this.resolveClosed({
      status: 'cancelled',
      reason: 'aborted',
      audioBytes: this.emitted ? 16_000 : 0,
      audioChunks: this.emitted ? 1 : 0,
      totalMs: 0,
    });
  }
}

class FakeTtsProvider implements StreamingTtsProvider {
  readonly name = 'fake-tts';
  readonly outputFormat = Object.freeze({
    encoding: 'pcm_s16' as const,
    sampleRateHz: 8000,
    channels: 1 as const,
  });
  readonly sessions: FakeTtsSession[] = [];

  async open(options: TtsSessionOptions): Promise<StreamingTtsSession> {
    const session = new FakeTtsSession(options, this.sessions.length + 1);
    this.sessions.push(session);
    return session;
  }
}

class RejectingTtsProvider implements StreamingTtsProvider {
  readonly name = 'rejecting-tts';
  readonly outputFormat = Object.freeze({
    encoding: 'pcm_s16' as const,
    sampleRateHz: 8000,
    channels: 1 as const,
  });

  async open(_options: TtsSessionOptions): Promise<StreamingTtsSession> {
    throw new Error('offline');
  }
}

class AbortOnlyTtsProvider implements StreamingTtsProvider {
  readonly name = 'abort-only-tts';
  readonly outputFormat = Object.freeze({
    encoding: 'pcm_s16' as const,
    sampleRateHz: 8000,
    channels: 1 as const,
  });
  aborted = false;

  open(options: TtsSessionOptions): Promise<StreamingTtsSession> {
    return new Promise((_resolve, reject) => {
      const abort = (): void => {
        this.aborted = true;
        reject(new Error('aborted'));
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
  }
}

class AutoFishWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly frames: Record<string, unknown>[] = [];

  constructor() {
    super();
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }

  send(data: unknown): void {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error('socket is not open');
    }
    const frame = decode(
      Buffer.from(data as Uint8Array)
    ) as Record<string, unknown>;
    this.frames.push(frame);

    if (frame['event'] === 'flush') {
      queueMicrotask(() => {
        this.emit(
          'message',
          Buffer.from(
            encode({
              event: 'audio',
              audio: new Uint8Array(160),
            })
          )
        );
      });
    } else if (frame['event'] === 'stop') {
      queueMicrotask(() => {
        this.emit(
          'message',
          Buffer.from(encode({ event: 'finish', reason: 'stop' }))
        );
      });
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

class CandidateRunner implements ModelRunner {
  readonly name: string;
  started = false;

  constructor(
    name: string,
    private readonly candidate: ModelCandidate
  ) {
    this.name = name;
  }

  async run(_request: ModelRunnerRequest): Promise<ModelCandidate> {
    this.started = true;
    return this.candidate;
  }
}

function candidate(
  texts: readonly string[],
  safeToCommit = true
): ModelCandidate {
  return {
    segments: texts.map((text, index) => ({
      text,
      assertions: [
        {
          key: `answer.part_${index}`,
          value: text.toLocaleLowerCase('ru'),
        },
      ],
    })),
    confidence: safeToCommit ? 0.99 : 0,
    safeToCommit,
    requiresDeep: false,
  };
}

function createOrchestrator(
  fast: ModelRunner,
  medium: ModelRunner = new CandidateRunner(
    'medium',
    candidate(['ignored'], false)
  )
): VoiceResponseOrchestrator {
  return new VoiceResponseOrchestrator({
    fast,
    medium,
    deadlinesMs: {
      fast: 500,
      medium: 500,
      deep: 500,
      classifier: 100,
      total: 1_000,
    },
  });
}

function eventCollector(): {
  events: VoiceRuntimeEvent[];
  onEvent: (event: VoiceRuntimeEvent) => void;
  waitFor: (
    predicate: (event: VoiceRuntimeEvent) => boolean
  ) => Promise<VoiceRuntimeEvent>;
} {
  const events: VoiceRuntimeEvent[] = [];
  const waiters = new Set<{
    predicate: (event: VoiceRuntimeEvent) => boolean;
    resolve: (event: VoiceRuntimeEvent) => void;
  }>();
  return {
    events,
    onEvent: event => {
      events.push(event);
      for (const waiter of waiters) {
        if (!waiter.predicate(event)) continue;
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    },
    waitFor: predicate => {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.add(waiter);
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('runtime event timeout'));
        }, 1_000);
        const originalResolve = waiter.resolve;
        waiter.resolve = event => {
          clearTimeout(timer);
          originalResolve(event);
        };
      });
    },
  };
}

const waitUntilAborted = (
  _delayMs: number,
  signal: AbortSignal
): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

test('uses Fish for greeting generation 1 and reserves generation 2 for the first user turn', async () => {
  const sockets: AutoFishWebSocket[] = [];
  const tts = new FishTtsProvider({
    apiKey: 'fish-test-key',
    referenceId: 'fish-test-voice',
    sampleRateHz: 8000,
    connectTimeoutMs: 500,
    firstAudioTimeoutMs: 500,
    finishTimeoutMs: 500,
    webSocketFactory: () => {
      const socket = new AutoFishWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const collector = eventCollector();
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-greeting',
    conversationId: 'conversation-greeting',
    systemPrompt: 'Be useful.',
    stt: new FakeSttProvider(),
    tts,
    orchestrator: createOrchestrator(
      new CandidateRunner('fast', candidate(['Ответ пользователю.']))
    ),
    greetingText: 'Здравствуйте!',
    onEvent: collector.onEvent,
    wait: waitUntilAborted,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  await collector.waitFor(
    event =>
      event.type === 'playback_flush' && event.generation === 1
  );

  assert.equal(sockets.length, 1);
  assert.deepEqual(
    sockets[0]?.frames.map(frame => frame['event']),
    ['start', 'text', 'flush', 'stop']
  );
  assert.equal(
    collector.events.some(event => event.type === 'fallback_speech'),
    false
  );

  runtime.notifyPlaybackEnded(1);
  await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      event.isFinal &&
      event.turn?.turnId === 'greeting' &&
      event.turn.generation === 1
  );

  runtime.sendText('Первый вопрос');
  await collector.waitFor(
    event =>
      event.type === 'playback_flush' && event.generation === 2
  );
  assert.equal(sockets.length, 2);

  // A delayed duplicate ACK for the greeting must not release user playback.
  runtime.notifyPlaybackEnded(1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(
    collector.events.some(
      event =>
        event.type === 'transcript' &&
        event.role === 'assistant' &&
        event.isFinal &&
        event.turn?.generation === 2
    ),
    false
  );

  runtime.notifyPlaybackEnded(2);
  await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      event.isFinal &&
      event.turn?.generation === 2
  );
  assert.equal(
    collector.events.some(event => event.type === 'fallback_speech'),
    false
  );
  await runtime.disconnect();
});

test('ignores empty Flux updates but still treats StartOfTurn as barge-in', async () => {
  const stt = new FakeSttProvider();
  const collector = eventCollector();
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-greeting-update',
    conversationId: 'conversation-greeting-update',
    systemPrompt: 'Be useful.',
    stt,
    tts: new FakeTtsProvider(),
    orchestrator: createOrchestrator(
      new CandidateRunner('fast', candidate(['Ответ пользователю.']))
    ),
    greetingText: 'Здравствуйте!',
    onEvent: collector.onEvent,
    wait: waitUntilAborted,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  await collector.waitFor(
    event =>
      event.type === 'playback_flush' && event.generation === 1
  );

  await stt.onEvent?.(fakeSttTurnEvent('update', '', 1));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(
    collector.events.some(event => event.type === 'playback_clear'),
    false
  );

  await stt.onEvent?.(fakeSttTurnEvent('start_of_turn', '', 2));
  await collector.waitFor(
    event =>
      event.type === 'playback_clear' && event.generation === 2
  );

  await runtime.disconnect();
});

test('barge-in clears audio that is still queued after Fish has completed', async () => {
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const collector = eventCollector();
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-1',
    conversationId: 'conversation-1',
    systemPrompt: 'Be useful.',
    stt,
    tts,
    orchestrator: createOrchestrator(
      new CandidateRunner('fast', candidate(['Первый ответ.']))
    ),
    onEvent: collector.onEvent,
    wait: waitUntilAborted,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  runtime.sendText('Первый вопрос');
  await collector.waitFor(
    event =>
      event.type === 'playback_flush' && event.generation === 1
  );

  assert.equal(
    collector.events.some(
      event =>
        event.type === 'transcript' &&
        event.role === 'assistant' &&
        event.isFinal &&
        event.turn?.generation === 1
    ),
    false
  );

  runtime.sendText('Перебиваю');
  await collector.waitFor(
    event =>
      event.type === 'playback_clear' && event.generation === 2
  );

  assert.equal(
    collector.events.some(
      event =>
        event.type === 'transcript' &&
        event.role === 'assistant' &&
        event.isFinal &&
        event.turn?.generation === 1
    ),
    false
  );
  await runtime.disconnect();
});

test('clear ACK cannot release the next generation before its audio is armed', async () => {
  let releaseSecondCandidate!: () => void;
  const secondCandidateGate = new Promise<void>(resolve => {
    releaseSecondCandidate = resolve;
  });
  let fastCalls = 0;
  const fast: ModelRunner = {
    name: 'deferred-second-fast',
    run: async () => {
      fastCalls += 1;
      if (fastCalls === 2) await secondCandidateGate;
      return candidate([
        fastCalls === 1 ? 'Первый ответ.' : 'Второй ответ.',
      ]);
    },
  };
  const collector = eventCollector();
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-ack-arm',
    conversationId: 'conversation-ack-arm',
    systemPrompt: 'Be useful.',
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    orchestrator: createOrchestrator(fast),
    onEvent: collector.onEvent,
    wait: waitUntilAborted,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  runtime.sendText('Первый вопрос');
  await collector.waitFor(
    event =>
      event.type === 'playback_flush' && event.generation === 1
  );

  runtime.sendText('Перебиваю вторым вопросом');
  await collector.waitFor(
    event =>
      event.type === 'playback_clear' && event.generation === 2
  );
  assert.equal(
    collector.events.some(
      event => event.type === 'audio' && event.generation === 2
    ),
    false
  );

  // Clearing generation 1 can produce MEDIA_ENDED tagged with the newly
  // selected generation. It is stale until generation 2 emits real audio.
  runtime.notifyPlaybackEnded(2);
  releaseSecondCandidate();
  await collector.waitFor(
    event =>
      event.type === 'playback_flush' && event.generation === 2
  );
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(
    collector.events.some(
      event =>
        event.type === 'transcript' &&
        event.role === 'assistant' &&
        event.isFinal &&
        event.turn?.generation === 2
    ),
    false
  );

  runtime.notifyPlaybackEnded(2);
  await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      event.isFinal &&
      event.turn?.generation === 2
  );
  await runtime.disconnect();
});

test('batches native fallback once instead of interrupting every segment', async () => {
  const collector = eventCollector();
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-2',
    conversationId: 'conversation-2',
    systemPrompt: 'Be useful.',
    stt: new FakeSttProvider(),
    tts: new RejectingTtsProvider(),
    orchestrator: createOrchestrator(
      new CandidateRunner(
        'fast',
        candidate(['Первая фраза.', 'Вторая фраза.'])
      )
    ),
    onEvent: collector.onEvent,
    wait: async () => undefined,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  runtime.sendText('Ответь двумя фразами');
  await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      event.isFinal
  );

  const fallbacks = collector.events.filter(
    (event): event is Extract<
      VoiceRuntimeEvent,
      { type: 'fallback_speech' }
    > => event.type === 'fallback_speech'
  );
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0]?.text, 'Первая фраза. Вторая фраза.');
  assert.equal(fallbacks[0]?.generation, 1);
  await runtime.disconnect();
});

test('starts fast model without waiting for RAG needed by medium tier', async () => {
  let resolveKnowledge!: (
    value: Readonly<Record<string, unknown>>
  ) => void;
  const knowledge = new Promise<Readonly<Record<string, unknown>>>(
    resolve => {
      resolveKnowledge = resolve;
    }
  );
  const fast = new CandidateRunner(
    'fast',
    candidate(['Быстрый ответ.'])
  );
  const medium = new CandidateRunner(
    'medium',
    candidate(['Дополнение.'], false)
  );
  const collector = eventCollector();
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-3',
    conversationId: 'conversation-3',
    systemPrompt: 'Be useful.',
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    orchestrator: createOrchestrator(fast, medium),
    onEvent: collector.onEvent,
    resolveModelContext: async () => knowledge,
    wait: async () => undefined,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  runtime.sendText('Быстрый вопрос');
  await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      !event.isFinal
  );

  assert.equal(fast.started, true);
  assert.equal(medium.started, false);
  resolveKnowledge({ knowledge: ['verified'] });
  await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      event.isFinal
  );
  assert.equal(medium.started, true);
  await runtime.disconnect();
});

test('total deadline cancels slow TTS open and completes with one fallback', async () => {
  const tts = new AbortOnlyTtsProvider();
  const collector = eventCollector();
  const fast = new CandidateRunner(
    'fast',
    candidate(['Ответ, который не успел открыться.'])
  );
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-4',
    conversationId: 'conversation-4',
    systemPrompt: 'Be useful.',
    stt: new FakeSttProvider(),
    tts,
    orchestrator: new VoiceResponseOrchestrator({
      fast,
      medium: new CandidateRunner(
        'medium',
        candidate(['ignored'], false)
      ),
      deadlinesMs: {
        fast: 100,
        medium: 100,
        deep: 100,
        classifier: 50,
        total: 25,
      },
    }),
    onEvent: collector.onEvent,
    safeDraft: 'Секунду, повторю ответ.',
    wait: async () => undefined,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  runtime.sendText('Проверь дедлайн');
  const final = await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      event.isFinal
  );

  assert.equal(tts.aborted, true);
  assert.equal(
    final.type === 'transcript' ? final.text : '',
    'Секунду, повторю ответ.'
  );
  assert.equal(
    collector.events.filter(event => event.type === 'fallback_speech')
      .length,
    1
  );
  await runtime.disconnect();
});

test('telephony playback acknowledgement releases the committed turn', async () => {
  const collector = eventCollector();
  const runtime = new RealtimeVoiceRuntime({
    callId: 'call-5',
    conversationId: 'conversation-5',
    systemPrompt: 'Be useful.',
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    orchestrator: createOrchestrator(
      new CandidateRunner('fast', candidate(['Готово.']))
    ),
    onEvent: collector.onEvent,
    wait: waitUntilAborted,
    playbackDrainPaddingMs: 0,
  });

  await runtime.connect();
  runtime.sendText('Ответь');
  await collector.waitFor(
    event =>
      event.type === 'playback_flush' && event.generation === 1
  );
  runtime.notifyPlaybackEnded(1);
  await collector.waitFor(
    event =>
      event.type === 'transcript' &&
      event.role === 'assistant' &&
      event.isFinal &&
      event.turn?.generation === 1
  );

  await new Promise<void>(resolve => setImmediate(resolve));
  runtime.sendText('Новый вопрос');
  assert.equal(
    collector.events.some(
      event =>
        event.type === 'playback_clear' && event.generation === 2
    ),
    false
  );
  await runtime.disconnect();
});
