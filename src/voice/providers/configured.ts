import { config } from '../../config';
import { FishTtsProvider } from './fish-tts';
import { TtsProviderError } from './tts';

export function isFishTtsConfigured(): boolean {
  return Boolean(config.FISH_API_KEY);
}

/**
 * Creates the provider lazily. Importing this module never opens a Fish socket,
 * and existing Gemini deployments do not require Fish credentials.
 */
export function createConfiguredFishTtsProvider(): FishTtsProvider {
  if (!config.FISH_API_KEY) {
    throw new TtsProviderError(
      'configuration',
      'FISH_API_KEY is required to enable Fish Audio TTS',
      false
    );
  }

  return new FishTtsProvider({
    apiKey: config.FISH_API_KEY,
    url: config.FISH_TTS_URL,
    allowCustomEndpoint: config.FISH_TTS_ALLOW_CUSTOM_ENDPOINT,
    model: config.FISH_TTS_MODEL,
    referenceId: config.FISH_TTS_REFERENCE_ID,
    latency: config.FISH_TTS_LATENCY,
    sampleRateHz: config.FISH_TTS_SAMPLE_RATE,
    chunkLength: config.FISH_TTS_CHUNK_LENGTH,
    connectTimeoutMs: config.FISH_TTS_CONNECT_TIMEOUT_MS,
    firstAudioTimeoutMs: config.FISH_TTS_FIRST_AUDIO_TIMEOUT_MS,
    finishTimeoutMs: config.FISH_TTS_FINISH_TIMEOUT_MS,
  });
}
