import { config } from '../config';
import { logger } from '../utils/logger';
import { requestCartesiaSpeechStream } from './cartesia';
import { requestSpeechStream as requestFishSpeechStream } from './fish-audio';

export type TtsProvider = 'cartesia' | 'fish';

export interface TtsStreamResult {
  response: Response;
  provider: TtsProvider;
  model: string;
}

export async function requestTtsStream(
  provider: TtsProvider,
  text: string,
  voiceId: string | undefined,
  speed = 1,
  model?: string
): Promise<TtsStreamResult> {
  if (provider === 'cartesia') {
    try {
      return {
        response: await requestCartesiaSpeechStream(
          text,
          voiceId ?? config.CARTESIA_DEFAULT_VOICE_ID,
          model ?? config.CARTESIA_MODEL
        ),
        provider: 'cartesia',
        model: model ?? config.CARTESIA_MODEL,
      };
    } catch (error) {
      if (!config.FISH_AUDIO_API_KEY) throw error;
      logger.warn('Cartesia unavailable, falling back to Fish Audio', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        response: await requestFishSpeechStream(
          text,
          config.FISH_AUDIO_DEFAULT_VOICE_ID,
          speed
        ),
        provider: 'fish',
        model: config.FISH_AUDIO_MODEL,
      };
    }
  }

  try {
    return {
      response: await requestFishSpeechStream(text, voiceId, speed),
      provider: 'fish',
      model: config.FISH_AUDIO_MODEL,
    };
  } catch (error) {
    if (!config.CARTESIA_API_KEY) throw error;
    logger.warn('Fish Audio unavailable, falling back to Cartesia', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      response: await requestCartesiaSpeechStream(
        text,
        config.CARTESIA_DEFAULT_VOICE_ID,
        config.CARTESIA_MODEL
      ),
      provider: 'cartesia',
      model: config.CARTESIA_MODEL,
    };
  }
}
