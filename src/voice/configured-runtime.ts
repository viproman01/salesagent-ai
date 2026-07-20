import Anthropic from '@anthropic-ai/sdk';
import type { ToolContext } from '../ai/tools';
import { GeminiLiveVoiceBridge } from '../ai/gemini-live';
import { config } from '../config';
import { searchKnowledge } from '../rag/search';
import { logger } from '../utils/logger';
import {
  AnthropicComplexityClassifier,
  AnthropicModelRunner,
  createAnthropicLowLatencyControls,
  type AnthropicCandidateLimits,
  type AnthropicClassifierLimits,
  type AnthropicMessagesClient,
} from './models/anthropic-runner';
import { VoiceResponseOrchestrator } from './orchestrator';
import { AssemblyAiStreamingSttProvider } from './providers/assemblyai-stt';
import { ColdFallbackStreamingSttProvider } from './providers/cold-fallback-stt';
import { createConfiguredFishTtsProvider } from './providers/configured';
import { DeepgramFluxSttProvider } from './providers/deepgram-stt';
import type { StreamingSttProvider } from './providers/stt';
import { RealtimeVoiceRuntime } from './realtime-runtime';
import type {
  VoiceRuntime,
  VoiceRuntimeEventHandler,
} from './runtime';

export type VoiceAgentConfiguration = Readonly<{
  systemPrompt: string;
  voice?: string;
  fishReferenceId?: string;
  speed?: number;
  greeting?: string;
}>;

export type ConfiguredVoiceRuntimeOptions = Readonly<{
  callId: string;
  conversationId: string;
  agent: VoiceAgentConfiguration;
  context: ToolContext;
  onEvent: VoiceRuntimeEventHandler;
}>;

type PipelineDependencies = Readonly<{
  stt: StreamingSttProvider;
  tts: ReturnType<typeof createConfiguredFishTtsProvider>;
  fast: AnthropicModelRunner;
  medium: AnthropicModelRunner;
  deep: AnthropicModelRunner;
  classifier: AnthropicComplexityClassifier;
}>;

const CANDIDATE_LIMITS: AnthropicCandidateLimits = Object.freeze({
  maxSegments: 3,
  maxSegmentCharacters: 240,
  maxAssertionsPerSegment: 8,
  maxAssertionKeyCharacters: 80,
  maxAssertionValueCharacters: 240,
  maxPromptCharacters: 4_000,
  maxContextCharacters: 24_000,
  maxResponseCharacters: 8_000,
});

const CLASSIFIER_LIMITS: AnthropicClassifierLimits = Object.freeze({
  maxPromptCharacters: 4_000,
  maxContextCharacters: 24_000,
  maxResponseCharacters: 1_000,
  maxReasonCharacters: 240,
});

let cachedPipeline: PipelineDependencies | undefined;

/**
 * Single composition root for both the legacy Gemini runtime and the
 * production multi-lane STT -> LLM -> Fish Audio pipeline.
 */
export function createConfiguredVoiceRuntime(
  options: ConfiguredVoiceRuntimeOptions
): VoiceRuntime {
  if (config.VOICE_RUNTIME === 'gemini') {
    return new GeminiLiveVoiceBridge(
      options.agent.systemPrompt,
      options.context,
      options.onEvent
    );
  }

  const dependencies = getPipelineDependencies();
  return new RealtimeVoiceRuntime({
    callId: options.callId,
    conversationId: options.conversationId,
    systemPrompt: options.agent.systemPrompt,
    stt: dependencies.stt,
    tts: dependencies.tts,
    orchestrator: createCallOrchestrator(dependencies),
    onEvent: options.onEvent,
    voiceId: normalizeFishReferenceId(options.agent),
    voiceSpeed: options.agent.speed,
    greetingText: options.agent.greeting?.trim() || config.VOICE_GREETING_TEXT,
    safeDraft: config.VOICE_SAFE_DRAFT,
    endpointingDelayMs: config.VOICE_ENDPOINTING_DELAY_MS,
    playbackDrainPaddingMs: config.VOICE_PLAYBACK_DRAIN_PADDING_MS,
    modelContext: {
      channel: 'voice',
      customer: {
        phone: options.context.phone,
      },
    },
    resolveModelContext: async (transcript, signal) => {
      const chunks = await raceAgainstAbort(
        searchKnowledge(options.context.orgId, transcript, 3, 0.55),
        signal
      );
      return {
        knowledge: chunks.map(chunk => ({
          content: chunk.content,
          category: chunk.category,
          source: chunk.source_file,
          similarity: chunk.similarity,
        })),
      };
    },
  });
}

function getPipelineDependencies(): PipelineDependencies {
  if (cachedPipeline) return cachedPipeline;

  if (!config.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is required for voice pipeline');
  }

  const anthropic = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
  }) as unknown as AnthropicMessagesClient;
  const fast = new AnthropicModelRunner({
    client: anthropic,
    name: 'voice-fast',
    model: config.VOICE_LLM_FAST_MODEL,
    maxTokens: 320,
    temperature: 0.1,
    limits: CANDIDATE_LIMITS,
  });
  const medium = new AnthropicModelRunner({
    client: anthropic,
    name: 'voice-medium',
    model: config.VOICE_LLM_MEDIUM_MODEL,
    maxTokens: 640,
    ...createAnthropicLowLatencyControls(
      config.VOICE_LLM_MEDIUM_MODEL,
      0.15
    ),
    limits: CANDIDATE_LIMITS,
  });
  const deep = new AnthropicModelRunner({
    client: anthropic,
    name: 'voice-deep',
    model: config.VOICE_LLM_DEEP_MODEL,
    maxTokens: 900,
    limits: CANDIDATE_LIMITS,
  });
  const classifier = new AnthropicComplexityClassifier({
    client: anthropic,
    name: 'voice-complexity',
    model: config.VOICE_LLM_FAST_MODEL,
    maxTokens: 96,
    temperature: 0,
    limits: CLASSIFIER_LIMITS,
  });

  cachedPipeline = Object.freeze({
    stt: createConfiguredSttProvider(),
    tts: createConfiguredFishTtsProvider(),
    fast,
    medium,
    deep,
    classifier,
  });

  return cachedPipeline;
}

function createConfiguredSttProvider(): StreamingSttProvider {
  const primary = new DeepgramFluxSttProvider({
    apiKey: config.DEEPGRAM_API_KEY!,
    url: config.DEEPGRAM_STT_URL,
    allowCustomEndpoint: config.DEEPGRAM_STT_ALLOW_CUSTOM_ENDPOINT,
    model: config.DEEPGRAM_STT_MODEL,
    languageHints: config.DEEPGRAM_STT_LANGUAGE_HINT
      .split(',')
      .map(language => language.trim())
      .filter(Boolean),
    eotThreshold: config.DEEPGRAM_STT_EOT_THRESHOLD,
    eotTimeoutMs: config.DEEPGRAM_STT_EOT_TIMEOUT_MS,
    connectTimeoutMs: config.DEEPGRAM_STT_CONNECT_TIMEOUT_MS,
    finishTimeoutMs: config.DEEPGRAM_STT_FINISH_TIMEOUT_MS,
    onEventHandlerError: (_error, context) => {
      logger.error('Deepgram event handler failed', context);
    },
  });

  if (!config.ASSEMBLYAI_API_KEY) return primary;

  const fallback = new AssemblyAiStreamingSttProvider({
    apiKey: config.ASSEMBLYAI_API_KEY,
    url: config.ASSEMBLYAI_STT_URL,
    allowCustomEndpoint: config.ASSEMBLYAI_STT_ALLOW_CUSTOM_ENDPOINT,
    speechModel: config.ASSEMBLYAI_STT_MODEL,
    minTurnSilenceMs: config.ASSEMBLYAI_STT_MIN_TURN_SILENCE_MS,
    maxTurnSilenceMs: config.ASSEMBLYAI_STT_MAX_TURN_SILENCE_MS,
    connectTimeoutMs: config.ASSEMBLYAI_STT_CONNECT_TIMEOUT_MS,
    finishTimeoutMs: config.ASSEMBLYAI_STT_FINISH_TIMEOUT_MS,
    forceEndpointTimeoutMs:
      config.ASSEMBLYAI_STT_FORCE_ENDPOINT_TIMEOUT_MS,
    onEventHandlerError: (_error, context) => {
      logger.error('AssemblyAI event handler failed', context);
    },
  });

  return new ColdFallbackStreamingSttProvider({
    primary,
    fallback,
    onFallback: context => {
      logger.warn('Voice STT cold fallback activated', context);
    },
  });
}

function createCallOrchestrator(
  dependencies: PipelineDependencies
): VoiceResponseOrchestrator {
  return new VoiceResponseOrchestrator({
    fast: dependencies.fast,
    medium: dependencies.medium,
    deep: dependencies.deep,
    classifier: dependencies.classifier,
    deadlinesMs: {
      fast: config.VOICE_LLM_FAST_TIMEOUT_MS,
      medium: config.VOICE_LLM_MEDIUM_TIMEOUT_MS,
      deep: config.VOICE_LLM_DEEP_TIMEOUT_MS,
      classifier: Math.min(500, config.VOICE_LLM_FAST_TIMEOUT_MS),
      total: config.VOICE_LLM_TOTAL_TIMEOUT_MS,
    },
    onMetric: metric => {
      logger.info('Voice orchestration metric', metric);
    },
  });
}

function normalizeFishReferenceId(
  agent: VoiceAgentConfiguration
): string | undefined {
  const explicit = agent.fishReferenceId?.trim();
  if (explicit) return explicit;

  // Existing agents contain Gemini names such as "Aoede" in `voice`. Only
  // UUID-like values are interpreted as Fish Audio reference IDs.
  const legacy = agent.voice?.trim();
  return legacy && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(legacy)
    ? legacy
    : undefined;
}

function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('voice context lookup was cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const cancelled = (): void => {
      cleanup();
      reject(new Error('voice context lookup was cancelled'));
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
