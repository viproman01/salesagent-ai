import { config } from '../config';
import { logger } from '../utils/logger';

export interface CartesiaVoice {
  id: string;
  name: string;
  language: string;
  gender: 'masculine' | 'feminine' | 'gender_neutral' | null;
  country: string | null;
}

export const CARTESIA_RUSSIAN_VOICES: CartesiaVoice[] = [
  { id: '779673f3-895f-4935-b6b5-b031dc78b319', name: 'Natalya — Soothing Guide', language: 'ru', gender: 'feminine', country: 'RU' },
  { id: '064b17af-d36b-4bfb-b003-be07dba1b649', name: 'Tatiana — Friendly Storyteller', language: 'ru', gender: 'feminine', country: 'RU' },
  { id: '642014de-c0e3-4133-adc0-36b5309c23e6', name: 'Irina — Poetic Voice', language: 'ru', gender: 'feminine', country: 'RU' },
  { id: '7a62541e-5492-410e-95ff-3abd096fce87', name: 'Natalia — Steady Strategist', language: 'ru', gender: 'feminine', country: 'RU' },
  { id: '25b7aaa6-1670-42dc-b791-419322400803', name: 'Daria — Decisive Dispatcher', language: 'ru', gender: 'feminine', country: 'RU' },
  { id: '9ed9f7e7-3ef6-4773-9dd3-ffcb479ca1f0', name: 'Olga — Confident Saleswoman', language: 'ru', gender: 'feminine', country: 'RU' },
  { id: '1e4176b1-3db9-44d6-a601-4fe68b041942', name: 'Sergei — Steady Supporter', language: 'ru', gender: 'masculine', country: 'RU' },
  { id: '069ff31a-5524-4945-a403-f746ee617507', name: 'Alexei — Articulate Analyst', language: 'ru', gender: 'masculine', country: 'RU' },
  { id: '888b7df4-e165-4852-bfec-0ab2b96aaa46', name: 'Dmitri — Gentle Voice', language: 'ru', gender: 'masculine', country: 'RU' },
];

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CartesiaError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export function createCartesiaTtsRequest(
  text: string,
  voiceId: string,
  model = config.CARTESIA_MODEL
): Record<string, unknown> {
  return {
    model_id: model,
    transcript: text,
    voice: { mode: 'id', id: voiceId },
    output_format: {
      container: 'mp3',
      sample_rate: 44_100,
      bit_rate: 128_000,
    },
    language: 'ru',
  };
}

export async function requestCartesiaSpeechStream(
  text: string,
  voiceId = config.CARTESIA_DEFAULT_VOICE_ID,
  model = config.CARTESIA_MODEL
): Promise<Response> {
  if (!config.CARTESIA_API_KEY) throw new Error('CARTESIA_API_KEY is not configured');
  if (!voiceId) throw new Error('Cartesia voice ID is not configured');

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < config.CARTESIA_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.CARTESIA_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.CARTESIA_API_KEY}`,
          'Cartesia-Version': config.CARTESIA_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createCartesiaTtsRequest(text, voiceId, model)),
      });
      if (response.ok) return response;
      const body = await response.text();
      throw new CartesiaError(
        `Cartesia ${response.status}: ${body.slice(0, 300)}`,
        [408, 429, 500, 502, 503, 504].includes(response.status)
      );
    } catch (error) {
      if (error instanceof CartesiaError && !error.retryable) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
    if (attempt + 1 < config.CARTESIA_MAX_ATTEMPTS) {
      await delay(180 * 2 ** attempt + Math.floor(Math.random() * 80));
    }
  }
  logger.error('Cartesia synthesis failed', { error: lastError?.message, model });
  throw lastError ?? new Error('Cartesia synthesis failed');
}

let voiceCache: { expiresAt: number; voices: CartesiaVoice[] } | null = null;

export async function listCartesiaRussianVoices(): Promise<CartesiaVoice[]> {
  if (!config.CARTESIA_API_KEY) return [];
  if (voiceCache && voiceCache.expiresAt > Date.now()) return voiceCache.voices;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.CARTESIA_TIMEOUT_MS);
  try {
    const url = new URL('https://api.cartesia.ai/voices');
    url.searchParams.set('language', 'ru');
    url.searchParams.set('limit', '100');
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.CARTESIA_API_KEY}`,
        'Cartesia-Version': config.CARTESIA_VERSION,
      },
    });
    if (!response.ok) throw new Error(`Cartesia voice catalog returned ${response.status}`);
    const payload = await response.json() as {
      data?: Array<{
        id: string;
        name: string;
        language: string;
        gender?: CartesiaVoice['gender'];
        country?: string | null;
      }>;
    };
    const voices = (payload.data ?? [])
      .filter(voice => voice.language === 'ru')
      .map(voice => ({
        id: voice.id,
        name: voice.name.replace(/\s*-\s*/, ' — ').trim(),
        language: voice.language,
        gender: voice.gender ?? null,
        country: voice.country ?? null,
      }))
      .sort((left, right) =>
        Number(left.id !== config.CARTESIA_DEFAULT_VOICE_ID)
        - Number(right.id !== config.CARTESIA_DEFAULT_VOICE_ID)
        || left.name.localeCompare(right.name, 'ru')
      );
    voiceCache = { expiresAt: Date.now() + 10 * 60_000, voices };
    return voices;
  } finally {
    clearTimeout(timeout);
  }
}
