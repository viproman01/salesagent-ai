import type { TurnRef } from './providers/tts';

export type VoiceRuntimeEvent =
  | { type: 'audio'; data: Buffer; generation?: number }
  | {
      type: 'transcript';
      text: string;
      isFinal: boolean;
      role?: 'user' | 'assistant';
      turn?: TurnRef;
    }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | {
      type: 'playback_clear';
      generation: number;
      reason: string;
    }
  | {
      type: 'playback_flush';
      generation: number;
    }
  | {
      type: 'fallback_speech';
      text: string;
      reason: string;
      generation?: number;
    }
  | {
      type: 'metric';
      name: string;
      value: number;
      unit: 'ms' | 'count';
      generation?: number;
    }
  | { type: 'error'; error: string }
  | { type: 'close' };

export type VoiceRuntimeEventHandler = (
  event: VoiceRuntimeEvent
) => void | Promise<void>;

/**
 * Common boundary between the telephony channel and a voice implementation.
 * Audio at this boundary is always G.711 μ-law, mono, 8 kHz.
 */
export interface VoiceRuntime {
  connect(): Promise<void>;
  sendAudio(ulaw8kChunk: Buffer): void;
  sendText?(text: string): void;
  notifyPlaybackEnded?(generation?: number): void;
  disconnect(): void | Promise<void>;
}
