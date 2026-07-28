import { config } from '../config';
import { logger } from '../utils/logger';

export const STT_AUDIO_FORMATS = ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'] as const;
export type SttAudioFormat = typeof STT_AUDIO_FORMATS[number];

export interface SttUsage {
  seconds: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TranscriptionResult {
  text: string;
  model: string;
  fallbackUsed: boolean;
  usage: SttUsage;
  latencyMs: number;
  generationId?: string;
}

interface OpenRouterSttPayload {
  text?: string;
  usage?: {
    seconds?: number;
    cost?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
}

class OpenRouterSttError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

export function createSttRequestBody(
  audio: Buffer,
  format: SttAudioFormat,
  model: string,
  language: string
): Record<string, unknown> {
  return {
    model,
    input_audio: {
      data: audio.toString('base64'),
      format,
    },
    language,
    temperature: 0,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transcribeWithModel(
  audio: Buffer,
  format: SttAudioFormat,
  model: string,
  language: string
): Promise<Omit<TranscriptionResult, 'fallbackUsed'>> {
  if (!config.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < config.OPENROUTER_STT_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.OPENROUTER_STT_TIMEOUT_MS);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.PUBLIC_BASE_URL ?? config.API_BASE_URL,
          'X-Title': 'SalesAgent AI',
        },
        body: JSON.stringify(createSttRequestBody(audio, format, model, language)),
      });
      const payload = await response.json().catch(() => ({})) as OpenRouterSttPayload;
      if (!response.ok) {
        throw new OpenRouterSttError(
          `OpenRouter STT ${response.status}: ${payload.error?.message ?? 'request failed'}`,
          response.status,
          [408, 429, 500, 502, 503, 504].includes(response.status)
        );
      }
      const text = payload.text?.trim() ?? '';
      if (!text) throw new OpenRouterSttError('OpenRouter STT returned an empty transcript', 502, true);
      return {
        text,
        model,
        latencyMs: Date.now() - started,
        generationId: response.headers.get('x-generation-id') ?? undefined,
        usage: {
          seconds: payload.usage?.seconds ?? 0,
          cost: payload.usage?.cost ?? 0,
          inputTokens: payload.usage?.input_tokens ?? 0,
          outputTokens: payload.usage?.output_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof OpenRouterSttError && !error.retryable) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
    if (attempt + 1 < config.OPENROUTER_STT_MAX_ATTEMPTS) {
      await wait(350 * 2 ** attempt + Math.floor(Math.random() * 150));
    }
  }
  throw lastError ?? new Error('OpenRouter STT request failed');
}

export async function transcribeAudio(
  audio: Buffer,
  format: SttAudioFormat,
  language = config.OPENROUTER_STT_LANGUAGE,
  primaryModel = config.OPENROUTER_STT_MODEL
): Promise<TranscriptionResult> {
  try {
    return {
      ...(await transcribeWithModel(audio, format, primaryModel, language)),
      fallbackUsed: false,
    };
  } catch (primaryError) {
    if (
      !config.OPENROUTER_STT_FALLBACK_MODEL
      || config.OPENROUTER_STT_FALLBACK_MODEL === primaryModel
    ) throw primaryError;
    logger.warn('Primary OpenRouter STT model unavailable, using fallback', {
      primaryModel,
      fallbackModel: config.OPENROUTER_STT_FALLBACK_MODEL,
      error: primaryError instanceof Error ? primaryError.message : String(primaryError),
    });
    return {
      ...(await transcribeWithModel(
        audio,
        format,
        config.OPENROUTER_STT_FALLBACK_MODEL,
        language
      )),
      fallbackUsed: true,
    };
  }
}

export function detectAudioFormat(
  mimeType: string,
  data: Buffer
): SttAudioFormat | null {
  const mime = mimeType.toLowerCase().split(';')[0]?.trim();
  if (mime === 'audio/webm' && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if ((mime === 'audio/wav' || mime === 'audio/x-wav') && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (mime === 'audio/ogg' && data.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (mime === 'audio/flac' && data.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (mime === 'audio/mpeg' && (data.subarray(0, 3).toString() === 'ID3' || (data[0] === 0xff && (data[1] ?? 0) >= 0xe0))) return 'mp3';
  if ((mime === 'audio/mp4' || mime === 'audio/m4a') && data.subarray(4, 8).toString() === 'ftyp') return 'm4a';
  if (mime === 'audio/aac' && data[0] === 0xff && ((data[1] ?? 0) & 0xf0) === 0xf0) return 'aac';
  return null;
}
