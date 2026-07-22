import { pcm16ToUlawAtSampleRate } from '../utils/audio';
import {
  type OrchestrationResult,
  type VoiceResponseOrchestrator,
} from './orchestrator';
import type {
  SttSessionEvent,
  SttTurnSnapshot,
  StreamingSttProvider,
  StreamingSttSession,
} from './providers/stt';
import type {
  CommittedSpeechSegment,
  StreamingTtsProvider,
  StreamingTtsSession,
  TtsTerminal,
  TurnRef,
} from './providers/tts';
import {
  type VoiceRuntime,
  type VoiceRuntimeEvent,
  type VoiceRuntimeEventHandler,
} from './runtime';
import {
  VoiceTurnManager,
  type TurnManagerEvent,
  type UserTurnCommittedEvent,
} from './turn-manager';

const GREETING_GENERATION = 1;

export type RealtimeVoiceRuntimeOptions = Readonly<{
  callId: string;
  conversationId: string;
  systemPrompt: string;
  stt: StreamingSttProvider;
  tts: StreamingTtsProvider;
  orchestrator: VoiceResponseOrchestrator;
  onEvent: VoiceRuntimeEventHandler;
  voiceId?: string;
  voiceSpeed?: number;
  greetingText?: string;
  safeDraft?: string;
  endpointingDelayMs?: number;
  modelContext?: Readonly<Record<string, unknown>>;
  resolveModelContext?: (
    transcript: string,
    signal: AbortSignal
  ) => Promise<Readonly<Record<string, unknown>>>;
  initialHistory?: readonly Readonly<{
    role: 'user' | 'assistant';
    text: string;
  }>[];
  maxQueuedAudioBytes?: number;
  playbackDrainPaddingMs?: number;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}>;

type RuntimeState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'disconnecting'
  | 'closed';

type TtsOpenResult =
  | Readonly<{ session: StreamingTtsSession }>
  | Readonly<{ error: Error }>;

/**
 * Full-duplex STT -> turn manager -> multi-model -> Fish TTS runtime.
 *
 * Every downstream task receives the Turn Manager's AbortSignal. A barge-in
 * therefore invalidates model output, TTS delivery, and telephony playback as
 * one synchronous generation transition.
 */
export class RealtimeVoiceRuntime implements VoiceRuntime {
  private readonly options: Required<
    Pick<
      RealtimeVoiceRuntimeOptions,
      | 'safeDraft'
      | 'endpointingDelayMs'
      | 'maxQueuedAudioBytes'
      | 'playbackDrainPaddingMs'
      | 'now'
      | 'wait'
    >
  > &
    RealtimeVoiceRuntimeOptions;
  private readonly rootController = new AbortController();
  private readonly turnManager: VoiceTurnManager;
  private readonly sttTurns = new Map<number, TurnRef>();
  private readonly completedSttTurns = new Set<number>();
  private readonly turnTasks = new Set<Promise<void>>();
  private readonly history: Array<{
    role: 'user' | 'assistant';
    text: string;
  }>;

  private state: RuntimeState = 'idle';
  private sttSession: StreamingSttSession | undefined;
  private connectPromise: Promise<void> | undefined;
  private disconnectPromise: Promise<void> | undefined;
  private audioWriteChain: Promise<void> = Promise.resolve();
  private queuedAudio: Buffer[] = [];
  private queuedAudioBytes = 0;
  private greetingController: AbortController | undefined;
  private greetingTask: Promise<void> | undefined;
  private closeEmitted = false;
  private fatal = false;
  private playbackUntilMs = 0;
  private playbackGeneration = 0;
  private armedPlaybackGeneration: number | undefined;
  private acknowledgedPlaybackGeneration: number | undefined;
  private playbackAcknowledged = new AbortController();

  constructor(options: RealtimeVoiceRuntimeOptions) {
    this.options = {
      ...options,
      safeDraft: options.safeDraft ?? 'Секунду, уточняю.',
      endpointingDelayMs: options.endpointingDelayMs ?? 0,
      maxQueuedAudioBytes: options.maxQueuedAudioBytes ?? 64 * 1024,
      playbackDrainPaddingMs: options.playbackDrainPaddingMs ?? 160,
      now: options.now ?? Date.now,
      wait: options.wait ?? waitAbortable,
    };
    if (!this.options.callId.trim() || !this.options.conversationId.trim()) {
      throw new Error('callId and conversationId are required');
    }
    if (!this.options.systemPrompt.trim()) {
      throw new Error('systemPrompt is required');
    }
    if (
      !Number.isInteger(this.options.maxQueuedAudioBytes) ||
      this.options.maxQueuedAudioBytes <= 0
    ) {
      throw new Error('maxQueuedAudioBytes must be a positive integer');
    }
    if (
      !Number.isFinite(this.options.playbackDrainPaddingMs) ||
      this.options.playbackDrainPaddingMs < 0
    ) {
      throw new Error('playbackDrainPaddingMs must be non-negative');
    }

    this.history = (options.initialHistory ?? []).slice(-20).map(item => ({
      role: item.role,
      text: item.text,
    }));
    this.turnManager = new VoiceTurnManager({
      callId: options.callId,
      conversationId: options.conversationId,
      initialGeneration: options.greetingText?.trim()
        ? GREETING_GENERATION
        : 0,
      endpointingDelayMs: this.options.endpointingDelayMs,
      onEvent: this.handleTurnManagerEvent,
    });
  }

  async connect(): Promise<void> {
    if (this.state === 'open') return;
    if (this.connectPromise) return this.connectPromise;
    if (this.state === 'disconnecting' || this.state === 'closed') {
      throw new Error('Voice runtime is already closed');
    }

    this.state = 'connecting';
    this.connectPromise = this.openStt();
    return this.connectPromise;
  }

  sendAudio(ulaw8kChunk: Buffer): void {
    if (
      this.state === 'disconnecting' ||
      this.state === 'closed' ||
      this.rootController.signal.aborted ||
      ulaw8kChunk.length === 0
    ) {
      return;
    }

    const audio = Buffer.from(ulaw8kChunk);
    if (!this.sttSession || this.state !== 'open') {
      this.queueConnectingAudio(audio);
      return;
    }
    this.enqueueAudioWrite(audio);
  }

  sendText(text: string): void {
    const normalized = text.trim();
    if (!normalized || this.state !== 'open') return;

    const lease = this.turnManager.speechStarted();
    this.turnManager.handleTranscript({
      turn: lease.turn,
      text: normalized,
      isFinal: true,
    });
    this.turnManager.speechStopped(lease.turn);
  }

  disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.disconnectPromise = this.closeRuntime();
    return this.disconnectPromise;
  }

  notifyPlaybackEnded(generation = this.playbackGeneration): void {
    if (
      !Number.isInteger(generation) ||
      generation !== this.armedPlaybackGeneration
    ) {
      return;
    }
    this.acknowledgedPlaybackGeneration = generation;
    this.playbackUntilMs = this.options.now();
    this.playbackAcknowledged.abort('telephony-playback-ended');
    this.playbackAcknowledged = new AbortController();
  }

  private async openStt(): Promise<void> {
    try {
      const session = await this.options.stt.open({
        stream: {
          callId: this.options.callId,
          conversationId: this.options.conversationId,
        },
        signal: this.rootController.signal,
        onEvent: this.handleSttEvent,
      });
      if (this.state !== 'connecting') {
        await session.finish();
        throw new Error('Voice runtime closed while STT was connecting');
      }

      this.sttSession = session;
      this.state = 'open';
      const queued = this.queuedAudio;
      this.queuedAudio = [];
      this.queuedAudioBytes = 0;
      for (const audio of queued) this.enqueueAudioWrite(audio);

      if (this.options.greetingText?.trim()) {
        const task = this.synthesizeGreeting(this.options.greetingText.trim());
        this.greetingTask = task;
        void task.finally(() => {
          if (this.greetingTask === task) this.greetingTask = undefined;
        });
      }
    } catch (error) {
      this.state = 'closed';
      this.rootController.abort('stt-connect-failed');
      await this.emitSafely({
        type: 'error',
        error: safeErrorMessage(error, 'Unable to connect streaming STT'),
      });
      throw error;
    }
  }

  private queueConnectingAudio(audio: Buffer): void {
    if (
      this.queuedAudioBytes + audio.length >
      this.options.maxQueuedAudioBytes
    ) {
      void this.failRuntime(
        new Error('Voice input queue exceeded its configured limit')
      );
      return;
    }
    this.queuedAudio.push(audio);
    this.queuedAudioBytes += audio.length;
  }

  private enqueueAudioWrite(audio: Buffer): void {
    this.audioWriteChain = this.audioWriteChain
      .then(async () => {
        const session = this.sttSession;
        if (
          !session ||
          session.state !== 'open' ||
          this.rootController.signal.aborted
        ) {
          return;
        }
        await session.writeAudio(audio);
      })
      .catch(error => this.failRuntime(error));
  }

  private readonly handleSttEvent = async (
    event: SttSessionEvent
  ): Promise<void> => {
    if (this.state === 'closed') return;

    if (event.type === 'session_started') {
      await this.emitSafely({
        type: 'metric',
        name: 'voice_stt_connect',
        value: event.connectMs,
        unit: 'ms',
      });
      return;
    }
    if (event.type === 'turn') {
      await this.handleSttTurn(event.turn);
      return;
    }
    if (event.type === 'error') {
      await this.emitSafely({
        type: 'error',
        error: `Streaming STT failed (${event.error.code})`,
      });
      return;
    }
    if (
      event.type === 'terminal' &&
      event.terminal.status === 'failed' &&
      this.state !== 'disconnecting'
    ) {
      await this.failRuntime(event.terminal.error);
    }
  };

  private async handleSttTurn(snapshot: SttTurnSnapshot): Promise<void> {
    if (
      this.state !== 'open' ||
      this.completedSttTurns.has(snapshot.turnIndex)
    ) {
      return;
    }

    let turn = this.sttTurns.get(snapshot.turnIndex);
    if (!turn) {
      const startsSpeech =
        snapshot.kind === 'start_of_turn' ||
        snapshot.kind === 'turn_resumed' ||
        snapshot.transcript.trim().length > 0;
      // Flux emits empty Update placeholders both before speech and after a
      // completed turn. They must not create a new generation or cancel the
      // response currently being prepared.
      if (!startsSpeech) return;

      const lease = this.turnManager.speechStarted();
      turn = lease.turn;
      this.sttTurns.set(snapshot.turnIndex, turn);
      this.trimSttTurnMaps();

      const greeting = this.greetingController;
      if (greeting && !greeting.signal.aborted) {
        greeting.abort('barge-in');
        this.clearPlaybackEstimate(turn.generation);
        await this.emitSafely({
          type: 'playback_clear',
          generation: turn.generation,
          reason: 'barge-in',
        });
      }
    } else if (
      snapshot.kind === 'start_of_turn' ||
      snapshot.kind === 'turn_resumed'
    ) {
      this.turnManager.speechStarted();
    }

    const isFinal = snapshot.kind === 'end_of_turn';
    this.turnManager.handleTranscript({
      turn,
      text: snapshot.transcript,
      isFinal,
    });

    if (snapshot.transcript.trim()) {
      await this.emit({
        type: 'transcript',
        role: 'user',
        text: snapshot.transcript,
        isFinal: false,
        turn,
      });
    }

    if (isFinal) {
      this.completedSttTurns.add(snapshot.turnIndex);
      this.turnManager.speechStopped(turn);
    }
  }

  private readonly handleTurnManagerEvent = (
    event: TurnManagerEvent
  ): void => {
    if (event.type === 'barge_in') {
      this.clearPlaybackEstimate(event.nextTurn.generation);
      void this.emitSafely({
        type: 'playback_clear',
        generation: event.nextTurn.generation,
        reason: 'barge-in',
      });
      return;
    }

    if (event.type === 'user_turn_committed') {
      const task = this.processCommittedTurn(event).catch(error =>
        this.failRuntime(error)
      );
      this.turnTasks.add(task);
      void task.then(
        () => this.turnTasks.delete(task),
        () => this.turnTasks.delete(task)
      );
    }
  };

  private async processCommittedTurn(
    event: UserTurnCommittedEvent
  ): Promise<void> {
    if (
      this.state !== 'open' ||
      event.signal.aborted ||
      !this.turnManager.isCurrent(event.turn)
    ) {
      return;
    }
    const turnStartedAtMs = this.options.now();

    this.appendHistory('user', event.transcript);
    await this.emit({
      type: 'transcript',
      role: 'user',
      text: event.transcript,
      isFinal: true,
      turn: event.turn,
    });

    const dynamicContextPromise = this.options.resolveModelContext
      ? raceAgainstAbort(
          this.options.resolveModelContext(
            event.transcript,
            event.signal
          ),
          event.signal
        )
      : undefined;

    let audioStarted = false;
    let ttsUnavailable = false;
    let lastTtsTerminal: TtsTerminal | undefined;
    const ttsController = new AbortController();
    relayAbort(event.signal, ttsController);
    const ttsOpening: Promise<TtsOpenResult> = this.options.tts
      .open({
        turn: event.turn,
        signal: ttsController.signal,
        voiceId: this.options.voiceId,
        speed: this.options.voiceSpeed,
        onEvent: async ttsEvent => {
          if (ttsEvent.type === 'session_started') {
            await this.emitSafely({
              type: 'metric',
              name: 'voice_tts_connect',
              value: ttsEvent.connectMs,
              unit: 'ms',
              generation: event.turn.generation,
            });
            return;
          }
          if (
            ttsEvent.type !== 'audio' ||
            event.signal.aborted ||
            ttsController.signal.aborted ||
            !this.turnManager.isCurrent(event.turn)
          ) {
            return;
          }
          audioStarted = true;
          const audio = pcm16ToUlawAtSampleRate(
            ttsEvent.data,
            ttsEvent.format.sampleRateHz
          );
          this.accountAudioPlayback(audio, event.turn.generation);
          if (ttsEvent.firstAudioMs !== undefined) {
            await this.emitSafely({
              type: 'metric',
              name: 'voice_tts_first_audio',
              value: ttsEvent.firstAudioMs,
              unit: 'ms',
              generation: event.turn.generation,
            });
          }
          await this.emit({
            type: 'audio',
            data: audio,
            generation: event.turn.generation,
          });
        },
      })
      .then(
        session => ({ session }),
        error => ({
          error:
            error instanceof Error
              ? error
              : new Error('Unable to open streaming TTS'),
        })
      );

    const baseModelContext = this.options.modelContext ?? {};
    const enrichedModelContext = dynamicContextPromise
      ? dynamicContextPromise.then(
          dynamic => ({
            ...baseModelContext,
            ...dynamic,
          }),
          async () => {
            if (
              !event.signal.aborted &&
              this.turnManager.isCurrent(event.turn)
            ) {
              await this.emitSafely({
                type: 'error',
                error: 'Knowledge context is temporarily unavailable',
              });
            }
            return baseModelContext;
          }
        )
      : Promise.resolve(baseModelContext);

    const run = this.options.orchestrator.start({
      turn: event.turn,
      prompt: event.transcript,
      safeDraft: this.options.safeDraft,
      signal: event.signal,
      trustedPolicy: this.options.systemPrompt,
      context: {
        ...baseModelContext,
        history: this.history.slice(-20),
      },
      contextForTier: async tier => ({
        ...(tier === 'fast'
          ? baseModelContext
          : await enrichedModelContext),
        history: this.history.slice(-20),
      }),
      onCommit: async (commit, commitSignal) => {
        if (
          event.signal.aborted ||
          commitSignal.aborted ||
          !this.turnManager.isCurrent(event.turn)
        ) {
          throw new Error('stale voice generation');
        }

        const opened = await raceAgainstAbort(
          ttsOpening,
          commitSignal
        );
        if (
          event.signal.aborted ||
          commitSignal.aborted ||
          !this.turnManager.isCurrent(event.turn)
        ) {
          throw new Error('stale voice generation');
        }
        if ('session' in opened && !ttsUnavailable) {
          try {
            await opened.session.write(commit.segment);
            if (
              event.signal.aborted ||
              commitSignal.aborted ||
              !this.turnManager.isCurrent(event.turn)
            ) {
              throw new Error('stale voice generation');
            }
            await opened.session.flush();
            if (
              event.signal.aborted ||
              commitSignal.aborted ||
              !this.turnManager.isCurrent(event.turn)
            ) {
              throw new Error('stale voice generation');
            }
          } catch {
            if (
              event.signal.aborted ||
              commitSignal.aborted ||
              !this.turnManager.isCurrent(event.turn)
            ) {
              throw new Error('stale voice generation');
            }
            ttsUnavailable = true;
          }
        } else {
          ttsUnavailable = true;
        }

        if (
          event.signal.aborted ||
          commitSignal.aborted ||
          !this.turnManager.isCurrent(event.turn)
        ) {
          throw new Error('stale voice generation');
        }

        // Persistence/telemetry happens after the irreversible speech commit
        // and therefore must never roll the semantic ledger back.
        await this.emitSafely({
          type: 'transcript',
          role: 'assistant',
          text: commit.segment.text,
          isFinal: false,
          turn: event.turn,
        });
      },
    });

    let orchestration: OrchestrationResult;
    try {
      orchestration = await run.completed;
    } catch (error) {
      await this.emitSafely({
        type: 'error',
        error: safeErrorMessage(error, 'Voice orchestration failed'),
      });
      orchestration = {
        status: 'cancelled',
        turn: event.turn,
        committed: [],
        metrics: {
          startedAtMs: Date.now(),
          draftLatencyMs: 0,
          totalMs: 0,
          estimatedComplexity: 0,
          deepTrigger: 'none',
          tiers: {
            fast: { runner: 'unknown', state: 'failed' },
            medium: { runner: 'unknown', state: 'failed' },
            deep: { runner: 'unknown', state: 'not_started' },
          },
          committedSegments: 0,
          rejectedContradictions: 0,
          rejectedDuplicates: 0,
          rejectedUnsafe: 0,
          invalidSegments: 0,
        },
      };
    }

    if (
      orchestration.status !== 'completed' &&
      orchestration.committed.length === 0
    ) {
      ttsController.abort(orchestration.status);
    }
    const opened = await ttsOpening;
    if ('session' in opened) {
      try {
        lastTtsTerminal = event.signal.aborted
          ? await opened.session.closed
          : await opened.session.finish();
      } catch {
        lastTtsTerminal = await opened.session.closed;
      }
    }

    const assistantText = orchestration.committed
      .map(commit => commit.segment.text)
      .join(' ')
      .trim();
    if (
      event.signal.aborted ||
      !this.turnManager.isCurrent(event.turn)
    ) {
      return;
    }

    let finalAssistantText = assistantText;
    const terminalFailureCode =
      lastTtsTerminal?.status === 'failed'
        ? lastTtsTerminal.error.code
        : undefined;
    const needsFallback =
      ttsUnavailable ||
      terminalFailureCode !== undefined ||
      assistantText.length === 0;

    if (needsFallback) {
      finalAssistantText ||= this.options.safeDraft;
      if (audioStarted) {
        this.clearPlaybackEstimate(event.turn.generation);
        await this.emitSafely({
          type: 'playback_clear',
          generation: event.turn.generation,
          reason: 'streaming-tts-interrupted',
        });
      }
      if (
        event.signal.aborted ||
        !this.turnManager.isCurrent(event.turn)
      ) {
        return;
      }
      this.accountNativeSpeechPlayback(
        finalAssistantText,
        event.turn.generation
      );
      await this.emitSafely({
        type: 'fallback_speech',
        text: finalAssistantText,
        reason:
          assistantText.length === 0
            ? 'no-committed-model-answer'
            : terminalFailureCode
              ? `streaming-tts-${terminalFailureCode}`
              : 'streaming-tts-unavailable',
        generation: event.turn.generation,
      });
      await this.emitSafely({
        type: 'metric',
        name: 'voice_tts_fallback',
        value: 1,
        unit: 'count',
        generation: event.turn.generation,
      });
    }

    if (
      event.signal.aborted ||
      !this.turnManager.isCurrent(event.turn)
    ) {
      return;
    }

    await this.emitSafely({
      type: 'playback_flush',
      generation: event.turn.generation,
    });
    await this.waitForPlaybackDrain(
      event.signal,
      event.turn.generation
    );
    if (event.signal.aborted || !this.turnManager.isCurrent(event.turn)) {
      return;
    }

    this.appendHistory('assistant', finalAssistantText);
    await this.emitSafely({
      type: 'transcript',
      role: 'assistant',
      text: finalAssistantText,
      isFinal: true,
      turn: event.turn,
    });
    await this.emitSafely({
      type: 'metric',
      name: 'voice_turn_total',
      value: Math.max(0, this.options.now() - turnStartedAtMs),
      unit: 'ms',
      generation: event.turn.generation,
    });

    if (!event.signal.aborted && this.turnManager.isCurrent(event.turn)) {
      this.turnManager.complete(event.turn);
    }
  }

  private async synthesizeGreeting(text: string): Promise<void> {
    const controller = new AbortController();
    this.greetingController = controller;
    const removeRelay = relayAbort(this.rootController.signal, controller);
    const turn: TurnRef = Object.freeze({
      callId: this.options.callId,
      conversationId: this.options.conversationId,
      turnId: 'greeting',
      generation: GREETING_GENERATION,
    });
    let audioStarted = false;

    try {
      const session = await this.options.tts.open({
        turn,
        signal: controller.signal,
        voiceId: this.options.voiceId,
        speed: this.options.voiceSpeed,
        onEvent: async event => {
          if (event.type !== 'audio' || controller.signal.aborted) return;
          audioStarted = true;
          const audio = pcm16ToUlawAtSampleRate(
            event.data,
            event.format.sampleRateHz
          );
          this.accountAudioPlayback(audio, turn.generation);
          await this.emit({
            type: 'audio',
            data: audio,
            generation: turn.generation,
          });
        },
      });
      const segment: CommittedSpeechSegment = Object.freeze({
        kind: 'committed',
        turn,
        sequence: 0,
        text,
      });
      await session.write(segment);
      await session.flush();
      const terminal = await session.finish();
      if (terminal.status === 'failed') {
        if (audioStarted) {
          this.clearPlaybackEstimate(turn.generation);
          await this.emitSafely({
            type: 'playback_clear',
            generation: turn.generation,
            reason: 'greeting-tts-interrupted',
          });
        }
        if (controller.signal.aborted) return;
        this.accountNativeSpeechPlayback(text, turn.generation);
        await this.emitSafely({
          type: 'fallback_speech',
          text,
          reason: `greeting-tts-${terminal.error.code}`,
          generation: turn.generation,
        });
        await this.emitSafely({
          type: 'playback_flush',
          generation: turn.generation,
        });
        await this.waitForPlaybackDrain(
          controller.signal,
          turn.generation
        );
        if (controller.signal.aborted) return;
        this.appendHistory('assistant', text);
        await this.emitSafely({
          type: 'transcript',
          role: 'assistant',
          text,
          isFinal: true,
          turn,
        });
      } else if (terminal.status === 'completed') {
        await this.emitSafely({
          type: 'playback_flush',
          generation: turn.generation,
        });
        await this.waitForPlaybackDrain(
          controller.signal,
          turn.generation
        );
        if (controller.signal.aborted) return;
        this.appendHistory('assistant', text);
        await this.emitSafely({
          type: 'transcript',
          role: 'assistant',
          text,
          isFinal: true,
          turn,
        });
      }
    } catch {
      if (!controller.signal.aborted) {
        if (audioStarted) {
          this.clearPlaybackEstimate(turn.generation);
          await this.emitSafely({
            type: 'playback_clear',
            generation: turn.generation,
            reason: 'greeting-tts-interrupted',
          });
        }
        if (controller.signal.aborted) return;
        this.accountNativeSpeechPlayback(text, turn.generation);
        await this.emitSafely({
          type: 'fallback_speech',
          text,
          reason: 'greeting-tts-unavailable',
          generation: turn.generation,
        });
        await this.emitSafely({
          type: 'playback_flush',
          generation: turn.generation,
        });
        await this.waitForPlaybackDrain(
          controller.signal,
          turn.generation
        );
        if (controller.signal.aborted) return;
        this.appendHistory('assistant', text);
        await this.emitSafely({
          type: 'transcript',
          role: 'assistant',
          text,
          isFinal: true,
          turn,
        });
      }
    } finally {
      removeRelay();
      if (this.greetingController === controller) {
        this.greetingController = undefined;
      }
    }
  }

  private async closeRuntime(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'disconnecting';

    await waitBounded(this.audioWriteChain, 500);
    const stt = this.sttSession;
    if (stt) {
      try {
        if (stt.state === 'open') await stt.finish();
        else await waitBounded(stt.closed, 2_000);
      } catch {
        // The call is ending; local cancellation below is authoritative.
      }
    }

    this.rootController.abort('disconnect');
    this.greetingController?.abort('disconnect');
    this.turnManager.dispose();
    await waitBounded(Promise.allSettled([...this.turnTasks]), 2_000);
    if (this.greetingTask) await waitBounded(this.greetingTask, 1_000);

    this.state = 'closed';
    this.queuedAudio = [];
    this.queuedAudioBytes = 0;
    if (!this.closeEmitted) {
      this.closeEmitted = true;
      await this.emitSafely({ type: 'close' });
    }
  }

  private async failRuntime(error: unknown): Promise<void> {
    if (this.fatal || this.state === 'closed') return;
    this.fatal = true;
    await this.emitSafely({
      type: 'error',
      error: safeErrorMessage(error, 'Realtime voice runtime failed'),
    });
    this.rootController.abort('runtime-failed');
    this.greetingController?.abort('runtime-failed');
    this.turnManager.dispose();
    this.state = 'closed';
    if (!this.closeEmitted) {
      this.closeEmitted = true;
      await this.emitSafely({ type: 'close' });
    }
  }

  private appendHistory(
    role: 'user' | 'assistant',
    text: string
  ): void {
    this.history.push({ role, text });
    if (this.history.length > 20) {
      this.history.splice(0, this.history.length - 20);
    }
  }

  private accountAudioPlayback(audio: Buffer, generation: number): void {
    this.armPlayback(generation);
    const now = this.options.now();
    const queuedFrom = Math.max(now, this.playbackUntilMs);
    this.playbackUntilMs = queuedFrom + Math.ceil(audio.length / 8);
  }

  private accountNativeSpeechPlayback(
    text: string,
    generation: number
  ): void {
    this.armPlayback(generation);
    const now = this.options.now();
    const characters = Array.from(text.trim()).length;
    const estimatedMs = Math.max(
      600,
      Math.min(30_000, Math.ceil((characters / 13) * 1_000))
    );
    this.playbackUntilMs =
      Math.max(now, this.playbackUntilMs) + estimatedMs;
  }

  private clearPlaybackEstimate(generation = this.playbackGeneration): void {
    this.playbackGeneration = generation;
    this.playbackUntilMs = this.options.now();
    this.armedPlaybackGeneration = undefined;
    this.acknowledgedPlaybackGeneration = undefined;
    this.playbackAcknowledged.abort('playback-cleared');
    this.playbackAcknowledged = new AbortController();
  }

  private armPlayback(generation: number): void {
    this.playbackGeneration = generation;
    if (this.armedPlaybackGeneration === generation) return;

    this.armedPlaybackGeneration = generation;
    this.acknowledgedPlaybackGeneration = undefined;
    this.playbackAcknowledged.abort('playback-generation-armed');
    this.playbackAcknowledged = new AbortController();
  }

  private async waitForPlaybackDrain(
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    if (this.acknowledgedPlaybackGeneration === generation) return;
    const delayMs = Math.max(
      0,
      this.playbackUntilMs -
        this.options.now() +
        this.options.playbackDrainPaddingMs
    );
    if (delayMs <= 0) return;

    const combined = new AbortController();
    const removeTurnRelay = relayAbort(signal, combined);
    const removeAckRelay = relayAbort(
      this.playbackAcknowledged.signal,
      combined
    );
    try {
      await this.options.wait(delayMs, combined.signal);
    } finally {
      removeTurnRelay();
      removeAckRelay();
    }
  }

  private trimSttTurnMaps(): void {
    while (this.sttTurns.size > 100) {
      const oldest = this.sttTurns.keys().next().value as
        | number
        | undefined;
      if (oldest === undefined) return;
      this.sttTurns.delete(oldest);
      this.completedSttTurns.delete(oldest);
    }
  }

  private emit(event: VoiceRuntimeEvent): Promise<void> {
    return Promise.resolve(this.options.onEvent(event));
  }

  private async emitSafely(event: VoiceRuntimeEvent): Promise<void> {
    try {
      await this.emit(event);
    } catch {
      // The primary delivery path owns transport failures; cleanup continues.
    }
  }
}

function relayAbort(
  source: AbortSignal,
  destination: AbortController
): () => void {
  if (source.aborted) {
    destination.abort(source.reason);
    return () => undefined;
  }
  const relay = (): void => destination.abort(source.reason);
  source.addEventListener('abort', relay, { once: true });
  return () => source.removeEventListener('abort', relay);
}

async function waitBounded<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message &&
    !/api[_ -]?key|authorization|token|secret/i.test(error.message)
  ) {
    return error.message.slice(0, 240);
  }
  return fallback;
}

function waitAbortable(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('voice turn was cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => {
      cleanup();
      reject(new Error('voice turn was cancelled'));
    };
    const cleanup = (): void =>
      signal.removeEventListener('abort', cancelled);
    signal.addEventListener('abort', cancelled, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}
