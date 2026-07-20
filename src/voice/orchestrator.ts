import type {
  CommittedSpeechSegment,
  TurnRef,
} from './providers/tts';

export type ModelTier = 'fast' | 'medium' | 'deep';

export type SemanticAssertion = Readonly<{
  /**
   * Stable domain key, for example `product.price` or `meeting.date`.
   * A key may only have one canonical value after it has been spoken.
   */
  key: string;
  /** Canonical (not presentation) value used for contradiction checks. */
  value: string;
}>;

export type ModelSpeechSegment = Readonly<{
  text: string;
  assertions: readonly SemanticAssertion[];
}>;

export type ModelCandidate = Readonly<{
  segments: readonly ModelSpeechSegment[];
  confidence: number;
  safeToCommit: boolean;
  /** Only the medium runner is allowed to use this escalation signal. */
  requiresDeep?: boolean;
}>;

export type ModelRunnerRequest = Readonly<{
  tier: ModelTier;
  prompt: string;
  context?: Readonly<Record<string, unknown>>;
  /** Trusted tenant policy; adapters must place it in a system-level field. */
  trustedPolicy?: string;
  turn: TurnRef;
  signal: AbortSignal;
  deadlineAtMs: number;
}>;

/**
 * SDK-neutral model boundary. An adapter may call a hosted API, a local model,
 * or a deterministic test double.
 */
export interface ModelRunner {
  readonly name: string;
  run(request: ModelRunnerRequest): Promise<ModelCandidate>;
}

export type DeepClassification = Readonly<{
  requiresDeep: boolean;
  reason?: string;
}>;

export type ComplexityClassifierRequest = Readonly<{
  prompt: string;
  context?: Readonly<Record<string, unknown>>;
  turn: TurnRef;
  signal: AbortSignal;
  deadlineAtMs: number;
  estimatedComplexity: number;
}>;

export interface ComplexityClassifier {
  readonly name: string;
  classify(
    request: ComplexityClassifierRequest
  ): Promise<DeepClassification>;
}

export interface OrchestratorClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type DeepTrigger =
  | 'complexity'
  | 'classifier'
  | 'medium'
  | 'none';

export type TierMetricState =
  | 'not_started'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type TierMetrics = Readonly<{
  runner: string;
  state: TierMetricState;
  latencyMs?: number;
}>;

export type OrchestrationMetrics = Readonly<{
  startedAtMs: number;
  draftLatencyMs: number;
  totalMs: number;
  estimatedComplexity: number;
  deepTrigger: DeepTrigger;
  tiers: Readonly<Record<ModelTier, TierMetrics>>;
  classifier?: TierMetrics;
  committedSegments: number;
  rejectedContradictions: number;
  rejectedDuplicates: number;
  rejectedUnsafe: number;
  invalidSegments: number;
}>;

export type OrchestratorMetricEvent =
  | Readonly<{
      type: 'tier_started' | 'tier_finished';
      tier: ModelTier;
      timestampMs: number;
      state: TierMetricState;
    }>
  | Readonly<{
      type: 'deep_triggered';
      trigger: Exclude<DeepTrigger, 'none'>;
      timestampMs: number;
    }>
  | Readonly<{
      type: 'segment_committed' | 'segment_rejected';
      tier: ModelTier;
      timestampMs: number;
      reason?: 'contradiction' | 'duplicate' | 'unsafe' | 'invalid';
    }>;

export type OrchestratorDraft = Readonly<{
  kind: 'draft';
  turn: TurnRef;
  text: string;
  createdAtMs: number;
}>;

export type OrchestratorCommit = Readonly<{
  kind: 'committed';
  source: ModelTier;
  assertions: readonly SemanticAssertion[];
  segment: CommittedSpeechSegment;
}>;

export type OrchestrationStatus =
  | 'completed'
  | 'cancelled'
  | 'deadline_exceeded';

export type OrchestrationResult = Readonly<{
  status: OrchestrationStatus;
  turn: TurnRef;
  committed: readonly OrchestratorCommit[];
  metrics: OrchestrationMetrics;
}>;

export type OrchestrationRequest = Readonly<{
  turn: TurnRef;
  prompt: string;
  /** A neutral acknowledgement. It is returned immediately and never sent to TTS. */
  safeDraft: string;
  context?: Readonly<Record<string, unknown>>;
  /** Trusted agent policy, kept separate from caller/RAG data. */
  trustedPolicy?: string;
  /**
   * Optional tier-specific context. It is resolved inside that tier's own
   * deadline, so a slow knowledge lookup cannot delay the fast lane.
   */
  contextForTier?: (
    tier: ModelTier,
    signal: AbortSignal
  ) => Promise<Readonly<Record<string, unknown>>>;
  /** Optional caller score in the inclusive 0..1 range. */
  complexity?: number;
  signal: AbortSignal;
  onCommit?: (
    commit: OrchestratorCommit,
    signal: AbortSignal
  ) => void | Promise<void>;
}>;

export type OrchestrationRun = Readonly<{
  draft: OrchestratorDraft;
  completed: Promise<OrchestrationResult>;
  cancel(reason?: string): void;
}>;

export type VoiceOrchestratorOptions = Readonly<{
  fast: ModelRunner;
  medium: ModelRunner;
  deep?: ModelRunner;
  classifier?: ComplexityClassifier;
  deadlinesMs?: Partial<
    Readonly<Record<ModelTier | 'classifier' | 'total', number>>
  >;
  complexityThreshold?: number;
  minimumConfidence?: Partial<Readonly<Record<ModelTier, number>>>;
  clock?: OrchestratorClock;
  onMetric?: (metric: OrchestratorMetricEvent) => void;
}>;

type ResolvedOptions = Readonly<{
  fast: ModelRunner;
  medium: ModelRunner;
  deep?: ModelRunner;
  classifier?: ComplexityClassifier;
  deadlinesMs: Readonly<
    Record<ModelTier | 'classifier' | 'total', number>
  >;
  complexityThreshold: number;
  minimumConfidence: Readonly<Record<ModelTier, number>>;
  clock: OrchestratorClock;
  onMetric?: (metric: OrchestratorMetricEvent) => void;
}>;

type MutableTierMetrics = {
  runner: string;
  state: TierMetricState;
  latencyMs?: number;
};

type MutableMetrics = {
  startedAtMs: number;
  estimatedComplexity: number;
  deepTrigger: DeepTrigger;
  tiers: Record<ModelTier, MutableTierMetrics>;
  classifier?: MutableTierMetrics;
  committedSegments: number;
  rejectedContradictions: number;
  rejectedDuplicates: number;
  rejectedUnsafe: number;
  invalidSegments: number;
};

type ActiveRun = Readonly<{
  generation: number;
  controller: AbortController;
}>;

const DEFAULT_DEADLINES = Object.freeze({
  fast: 600,
  medium: 1_800,
  deep: 4_000,
  classifier: 350,
  total: 5_000,
});

const DEFAULT_MINIMUM_CONFIDENCE = Object.freeze({
  fast: 0.9,
  medium: 0.75,
  deep: 0.75,
});

const REAL_CLOCK: OrchestratorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

class DeadlineExceededError extends Error {
  constructor(readonly scope: string) {
    super(`${scope} deadline exceeded`);
    this.name = 'DeadlineExceededError';
  }
}

export class StaleVoiceGenerationError extends Error {
  constructor(generation: number, latestGeneration: number) {
    super(
      `Generation ${generation} is not newer than ${latestGeneration}`
    );
    this.name = 'StaleVoiceGenerationError';
  }
}

/**
 * Runs the latency and quality lanes concurrently while preserving one
 * irreversible semantic ledger for speech that has already been delivered.
 */
export class VoiceResponseOrchestrator {
  private readonly options: ResolvedOptions;
  private readonly active = new Map<string, ActiveRun>();
  private readonly latestGeneration = new Map<string, number>();

  constructor(options: VoiceOrchestratorOptions) {
    this.options = resolveOptions(options);
  }

  start(request: OrchestrationRequest): OrchestrationRun {
    validateRequest(request);

    const key = conversationKey(request.turn);
    const latest = this.latestGeneration.get(key);
    if (latest !== undefined && request.turn.generation <= latest) {
      throw new StaleVoiceGenerationError(
        request.turn.generation,
        latest
      );
    }

    this.latestGeneration.set(key, request.turn.generation);
    this.active.get(key)?.controller.abort('superseded');

    const controller = new AbortController();
    const activeRun: ActiveRun = {
      generation: request.turn.generation,
      controller,
    };
    this.active.set(key, activeRun);

    const startedAtMs = this.options.clock.now();
    const draft: OrchestratorDraft = Object.freeze({
      kind: 'draft',
      turn: request.turn,
      text: request.safeDraft.trim(),
      createdAtMs: startedAtMs,
    });

    const removeAbortRelay = relayAbort(request.signal, controller);
    const totalTimer = this.options.clock.setTimeout(
      () => controller.abort('total-deadline'),
      this.options.deadlinesMs.total
    );

    // Deferring all runners guarantees that the safe draft is returned before
    // even a badly behaved runner can do synchronous work.
    const completed = Promise.resolve()
      .then(() =>
        this.execute(
          request,
          controller,
          startedAtMs
        )
      )
      .finally(() => {
        removeAbortRelay();
        this.options.clock.clearTimeout(totalTimer);
        if (this.active.get(key) === activeRun) {
          this.active.delete(key);
        }
      });

    return Object.freeze({
      draft,
      completed,
      cancel: (reason = 'cancelled') => controller.abort(reason),
    });
  }

  private async execute(
    request: OrchestrationRequest,
    controller: AbortController,
    startedAtMs: number
  ): Promise<OrchestrationResult> {
    const complexity =
      request.complexity ?? estimatePromptComplexity(request.prompt);
    const metrics = createMetrics(
      startedAtMs,
      complexity,
      this.options
    );
    const committed: OrchestratorCommit[] = [];
    const semanticLedger = new Map<string, string>();
    const spokenTexts = new Set<string>();
    let nextSequence = 0;
    let commitChain = Promise.resolve();
    let deepPromise: Promise<void> | undefined;

    const emitMetric = (event: OrchestratorMetricEvent): void => {
      try {
        this.options.onMetric?.(event);
      } catch {
        // Telemetry must never affect a live conversation.
      }
    };

    const enqueueCandidate = (
      tier: ModelTier,
      candidate: ModelCandidate
    ): Promise<void> => {
      const delivery = commitChain.then(async () => {
        if (controller.signal.aborted) return;

        if (
          !candidate.safeToCommit ||
          candidate.confidence < this.options.minimumConfidence[tier]
        ) {
          metrics.rejectedUnsafe += candidate.segments.length;
          for (const _segment of candidate.segments) {
            emitMetric({
              type: 'segment_rejected',
              tier,
              timestampMs: this.options.clock.now(),
              reason: 'unsafe',
            });
          }
          return;
        }

        for (const modelSegment of candidate.segments) {
          if (controller.signal.aborted) return;

          const checked = checkSegment(
            modelSegment,
            semanticLedger,
            spokenTexts
          );
          if (checked.status !== 'accepted') {
            if (checked.status === 'contradiction') {
              metrics.rejectedContradictions++;
            } else if (checked.status === 'duplicate') {
              metrics.rejectedDuplicates++;
            } else {
              metrics.invalidSegments++;
            }
            emitMetric({
              type: 'segment_rejected',
              tier,
              timestampMs: this.options.clock.now(),
              reason: checked.status,
            });
            continue;
          }

          const commit: OrchestratorCommit = Object.freeze({
            kind: 'committed',
            source: tier,
            assertions: Object.freeze(checked.assertions),
            segment: Object.freeze({
              kind: 'committed',
              turn: request.turn,
              sequence: nextSequence,
              text: modelSegment.text.trim(),
            }),
          });

          try {
            await raceAgainstAbort(
              Promise.resolve(
                request.onCommit?.(commit, controller.signal)
              ),
              controller.signal
            );
          } catch {
            if (controller.signal.aborted) return;
            metrics.invalidSegments++;
            emitMetric({
              type: 'segment_rejected',
              tier,
              timestampMs: this.options.clock.now(),
              reason: 'invalid',
            });
            continue;
          }

          if (controller.signal.aborted) return;
          for (const assertion of checked.normalizedAssertions) {
            semanticLedger.set(assertion.key, assertion.value);
          }
          spokenTexts.add(checked.normalizedText);
          committed.push(commit);
          nextSequence++;
          metrics.committedSegments++;
          emitMetric({
            type: 'segment_committed',
            tier,
            timestampMs: this.options.clock.now(),
          });
        }
      });

      commitChain = delivery.catch(() => undefined);
      return delivery;
    };

    const runTier = async (
      tier: ModelTier,
      runner: ModelRunner
    ): Promise<ModelCandidate | undefined> => {
      const tierMetric = metrics.tiers[tier];
      if (controller.signal.aborted) {
        tierMetric.state = 'cancelled';
        return undefined;
      }

      tierMetric.state = 'running';
      const tierStartedAt = this.options.clock.now();
      emitMetric({
        type: 'tier_started',
        tier,
        timestampMs: tierStartedAt,
        state: 'running',
      });

      try {
        const candidate = await withDeadline(
          `${tier} model`,
          this.options.deadlinesMs[tier],
          controller.signal,
          this.options.clock,
          signal =>
            Promise.resolve(
              request.contextForTier?.(tier, signal) ??
                request.context
            ).then(context =>
              runner.run({
                tier,
                prompt: request.prompt,
                context,
                trustedPolicy: request.trustedPolicy,
                turn: request.turn,
                signal,
                deadlineAtMs:
                  tierStartedAt + this.options.deadlinesMs[tier],
              })
            )
        );

        tierMetric.state = 'succeeded';
        tierMetric.latencyMs =
          this.options.clock.now() - tierStartedAt;
        emitMetric({
          type: 'tier_finished',
          tier,
          timestampMs: this.options.clock.now(),
          state: 'succeeded',
        });
        return candidate;
      } catch (error) {
        tierMetric.state = classifyFailure(error, controller.signal);
        tierMetric.latencyMs =
          this.options.clock.now() - tierStartedAt;
        emitMetric({
          type: 'tier_finished',
          tier,
          timestampMs: this.options.clock.now(),
          state: tierMetric.state,
        });
        return undefined;
      }
    };

    const triggerDeep = (
      trigger: Exclude<DeepTrigger, 'none'>
    ): Promise<void> => {
      if (
        deepPromise ||
        controller.signal.aborted ||
        !this.options.deep
      ) {
        return deepPromise ?? Promise.resolve();
      }

      metrics.deepTrigger = trigger;
      emitMetric({
        type: 'deep_triggered',
        trigger,
        timestampMs: this.options.clock.now(),
      });
      deepPromise = runTier('deep', this.options.deep).then(
        async candidate => {
          if (candidate) await enqueueCandidate('deep', candidate);
        }
      );
      return deepPromise;
    };

    const runClassifier = async (): Promise<void> => {
      const classifier = this.options.classifier;
      const classifierMetric = metrics.classifier;
      if (!classifier || !classifierMetric || controller.signal.aborted) {
        return;
      }

      classifierMetric.state = 'running';
      const classifierStartedAt = this.options.clock.now();
      try {
        const decision = await withDeadline(
          'classifier',
          this.options.deadlinesMs.classifier,
          controller.signal,
          this.options.clock,
          signal =>
            classifier.classify({
              prompt: request.prompt,
              context: request.context,
              turn: request.turn,
              signal,
              deadlineAtMs:
                classifierStartedAt +
                this.options.deadlinesMs.classifier,
              estimatedComplexity: complexity,
            })
        );
        classifierMetric.state = 'succeeded';
        classifierMetric.latencyMs =
          this.options.clock.now() - classifierStartedAt;
        if (decision.requiresDeep) {
          void triggerDeep('classifier');
        }
      } catch (error) {
        classifierMetric.state = classifyFailure(
          error,
          controller.signal
        );
        classifierMetric.latencyMs =
          this.options.clock.now() - classifierStartedAt;
      }
    };

    if (complexity >= this.options.complexityThreshold) {
      void triggerDeep('complexity');
    }

    // Invoked without awaiting: both latency lanes start in the same turn of
    // the microtask queue and make progress independently.
    const fastPromise = runTier('fast', this.options.fast).then(
      async candidate => {
        if (candidate) await enqueueCandidate('fast', candidate);
      }
    );
    const mediumPromise = runTier('medium', this.options.medium).then(
      async candidate => {
        if (!candidate) return;
        if (candidate.requiresDeep) {
          void triggerDeep('medium');
        }
        await enqueueCandidate('medium', candidate);
      }
    );
    const classifierPromise = runClassifier();

    await Promise.all([
      fastPromise,
      mediumPromise,
      classifierPromise,
    ]);
    if (deepPromise) await deepPromise;
    await commitChain;

    const status = orchestrationStatus(controller.signal);
    return Object.freeze({
      status,
      turn: request.turn,
      committed: Object.freeze([...committed]),
      metrics: freezeMetrics(
        metrics,
        this.options.clock.now() - startedAtMs
      ),
    });
  }
}

/**
 * Small deterministic heuristic used only when the caller has no explicit
 * complexity score. It never calls a model and is safe on the hot path.
 */
export function estimatePromptComplexity(prompt: string): number {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return 0;

  const words = normalized.split(/\s+/u).length;
  const clauses = normalized.split(/[?!.;]+/u).filter(Boolean).length;
  const markers = [
    'анализ',
    'сравн',
    'рассч',
    'интеграц',
    'архитект',
    'юрид',
    'analy',
    'compar',
    'calculat',
    'integrat',
    'architect',
    'legal',
  ];
  const hasComplexMarker = markers.some(marker =>
    normalized.includes(marker)
  );

  const wordScore = Math.min(words / 180, 0.5);
  const clauseScore = Math.min(Math.max(clauses - 1, 0) * 0.1, 0.3);
  const markerScore = hasComplexMarker ? 0.3 : 0;
  return Math.min(1, wordScore + clauseScore + markerScore);
}

function resolveOptions(
  options: VoiceOrchestratorOptions
): ResolvedOptions {
  const deadlinesMs = {
    ...DEFAULT_DEADLINES,
    ...options.deadlinesMs,
  };
  const minimumConfidence = {
    ...DEFAULT_MINIMUM_CONFIDENCE,
    ...options.minimumConfidence,
  };

  for (const [name, value] of Object.entries(deadlinesMs)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} deadline must be a positive number`);
    }
  }
  for (const [tier, value] of Object.entries(minimumConfidence)) {
    if (!inUnitRange(value)) {
      throw new Error(`${tier} minimum confidence must be in 0..1`);
    }
  }

  const complexityThreshold = options.complexityThreshold ?? 0.7;
  if (!inUnitRange(complexityThreshold)) {
    throw new Error('complexityThreshold must be in 0..1');
  }

  return {
    ...options,
    deadlinesMs,
    minimumConfidence,
    complexityThreshold,
    clock: options.clock ?? REAL_CLOCK,
  };
}

function validateRequest(request: OrchestrationRequest): void {
  if (!request.prompt.trim()) throw new Error('prompt is required');
  if (!request.safeDraft.trim()) throw new Error('safeDraft is required');
  if (
    request.complexity !== undefined &&
    !inUnitRange(request.complexity)
  ) {
    throw new Error('complexity must be in 0..1');
  }
  if (!Number.isSafeInteger(request.turn.generation)) {
    throw new Error('turn generation must be a safe integer');
  }
}

function inUnitRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function conversationKey(turn: TurnRef): string {
  return `${turn.callId}\u0000${turn.conversationId}`;
}

function createMetrics(
  startedAtMs: number,
  estimatedComplexity: number,
  options: ResolvedOptions
): MutableMetrics {
  return {
    startedAtMs,
    estimatedComplexity,
    deepTrigger: 'none',
    tiers: {
      fast: {
        runner: options.fast.name,
        state: 'not_started',
      },
      medium: {
        runner: options.medium.name,
        state: 'not_started',
      },
      deep: {
        runner: options.deep?.name ?? 'not-configured',
        state: 'not_started',
      },
    },
    classifier: options.classifier
      ? {
          runner: options.classifier.name,
          state: 'not_started',
        }
      : undefined,
    committedSegments: 0,
    rejectedContradictions: 0,
    rejectedDuplicates: 0,
    rejectedUnsafe: 0,
    invalidSegments: 0,
  };
}

function freezeMetrics(
  metrics: MutableMetrics,
  totalMs: number
): OrchestrationMetrics {
  const freezeTier = (metric: MutableTierMetrics): TierMetrics =>
    Object.freeze({ ...metric });

  return Object.freeze({
    startedAtMs: metrics.startedAtMs,
    draftLatencyMs: 0,
    totalMs,
    estimatedComplexity: metrics.estimatedComplexity,
    deepTrigger: metrics.deepTrigger,
    tiers: Object.freeze({
      fast: freezeTier(metrics.tiers.fast),
      medium: freezeTier(metrics.tiers.medium),
      deep: freezeTier(metrics.tiers.deep),
    }),
    classifier: metrics.classifier
      ? freezeTier(metrics.classifier)
      : undefined,
    committedSegments: metrics.committedSegments,
    rejectedContradictions: metrics.rejectedContradictions,
    rejectedDuplicates: metrics.rejectedDuplicates,
    rejectedUnsafe: metrics.rejectedUnsafe,
    invalidSegments: metrics.invalidSegments,
  });
}

type SegmentCheck =
  | Readonly<{
      status: 'accepted';
      assertions: readonly SemanticAssertion[];
      normalizedAssertions: readonly SemanticAssertion[];
      normalizedText: string;
    }>
  | Readonly<{
      status: 'contradiction' | 'duplicate' | 'invalid';
    }>;

function checkSegment(
  segment: ModelSpeechSegment,
  ledger: ReadonlyMap<string, string>,
  spokenTexts: ReadonlySet<string>
): SegmentCheck {
  const normalizedText = normalizeSemanticValue(segment.text);
  if (!normalizedText) {
    return { status: 'invalid' };
  }
  if (spokenTexts.has(normalizedText)) {
    return { status: 'duplicate' };
  }

  // Conversational phrases such as acknowledgements and transitions contain
  // no checkable facts. The model contract represents those with an empty
  // assertions array; they are safe to speak once the candidate-level safety
  // and confidence gates above have passed.
  if (segment.assertions.length === 0) {
    return {
      status: 'accepted',
      assertions: Object.freeze([]),
      normalizedAssertions: Object.freeze([]),
      normalizedText,
    };
  }

  const seenInSegment = new Map<string, string>();
  const assertions: SemanticAssertion[] = [];
  const normalizedAssertions: SemanticAssertion[] = [];
  let hasNovelMeaning = false;

  for (const raw of segment.assertions) {
    const key = normalizeSemanticValue(raw.key);
    const value = normalizeSemanticValue(raw.value);
    if (!key || !value) return { status: 'invalid' };

    const valueInSegment = seenInSegment.get(key);
    if (valueInSegment !== undefined && valueInSegment !== value) {
      return { status: 'contradiction' };
    }
    seenInSegment.set(key, value);

    const spokenValue = ledger.get(key);
    if (spokenValue !== undefined && spokenValue !== value) {
      return { status: 'contradiction' };
    }
    if (spokenValue === undefined) hasNovelMeaning = true;

    assertions.push(
      Object.freeze({ key: raw.key.trim(), value: raw.value.trim() })
    );
    normalizedAssertions.push(Object.freeze({ key, value }));
  }

  if (!hasNovelMeaning) return { status: 'duplicate' };
  return {
    status: 'accepted',
    assertions,
    normalizedAssertions,
    normalizedText,
  };
}

function normalizeSemanticValue(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ');
}

async function withDeadline<T>(
  scope: string,
  delayMs: number,
  parentSignal: AbortSignal,
  clock: OrchestratorClock,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (parentSignal.aborted) {
    throw abortError(parentSignal.reason);
  }

  const controller = new AbortController();
  const removeRelay = relayAbort(parentSignal, controller);
  let deadlineReached = false;
  const timer = clock.setTimeout(() => {
    deadlineReached = true;
    controller.abort(`${scope}-deadline`);
  }, delayMs);

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      abortPromise(controller.signal).then(() => {
        if (deadlineReached) throw new DeadlineExceededError(scope);
        throw abortError(controller.signal.reason);
      }),
    ]);
  } finally {
    removeRelay();
    clock.clearTimeout(timer);
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

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve =>
    signal.addEventListener('abort', () => resolve(), { once: true })
  );
}

async function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw abortError(signal.reason);
  return Promise.race([
    promise,
    abortPromise(signal).then(() => {
      throw abortError(signal.reason);
    }),
  ]);
}

function abortError(reason: unknown): Error {
  const error = new Error(
    typeof reason === 'string' ? reason : 'aborted'
  );
  error.name = 'AbortError';
  return error;
}

function classifyFailure(
  error: unknown,
  parentSignal: AbortSignal
): TierMetricState {
  if (error instanceof DeadlineExceededError) return 'timed_out';
  if (parentSignal.aborted) return 'cancelled';
  return 'failed';
}

function orchestrationStatus(
  signal: AbortSignal
): OrchestrationStatus {
  if (!signal.aborted) return 'completed';
  return signal.reason === 'total-deadline'
    ? 'deadline_exceeded'
    : 'cancelled';
}
