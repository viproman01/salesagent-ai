import { config } from '../config';
import { logger } from '../utils/logger';

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
class FishAudioError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export async function synthesizeSpeech(text: string, voiceId: string | undefined, speed = 1): Promise<Buffer> {
  const response = await requestSpeechStream(text, voiceId, speed);
  return Buffer.from(await response.arrayBuffer());
}

export async function requestSpeechStream(
  text: string,
  voiceId: string | undefined,
  speed = 1
): Promise<Response> {
  if (!config.FISH_AUDIO_API_KEY) throw new Error('FISH_AUDIO_API_KEY is not configured');
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < config.FISH_AUDIO_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.FISH_AUDIO_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.FISH_AUDIO_API_KEY}`,
          'Content-Type': 'application/json',
          model: config.FISH_AUDIO_MODEL,
        },
        body: JSON.stringify({
          text,
          ...(voiceId ? { reference_id: voiceId } : {}),
          format: 'mp3',
          sample_rate: 44100,
          mp3_bitrate: 128,
          latency: 'balanced',
          normalize: true,
          chunk_length: 100,
          temperature: 0.35,
          top_p: 0.6,
          prosody: { speed, volume: 0, normalize_loudness: true },
        }),
      });
      if (response.ok) return response;
      const body = await response.text();
      throw new FishAudioError(
        `Fish Audio ${response.status}: ${body.slice(0, 300)}`,
        [408, 429, 500, 502, 503, 504].includes(response.status)
      );
    } catch (error) {
      if (error instanceof FishAudioError && !error.retryable) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
    if (attempt + 1 < config.FISH_AUDIO_MAX_ATTEMPTS) {
      await delay(300 * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
  logger.error('Fish Audio synthesis failed', { error: lastError?.message });
  throw lastError ?? new Error('Fish Audio synthesis failed');
}
