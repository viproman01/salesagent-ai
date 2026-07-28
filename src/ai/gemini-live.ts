import type { ToolContext } from './tools';

/**
 * Kept only so old imports fail explicitly during the transition. Gemini Live
 * is intentionally replaced by the HTTP turn-taking OpenRouter + Fish flow.
 */
export class GeminiLiveVoiceBridge {
  constructor(
    _systemPrompt: string,
    _context: ToolContext,
    _onEvent: (event: { type: string; data?: Buffer; text?: string; isFinal?: boolean }) => void,
  ) {}
  async connect(): Promise<void> { throw new Error('Gemini Live is disabled; use Fish Audio voice endpoints'); }
  sendAudio(_audio: Buffer): void { throw new Error('Gemini Live is disabled'); }
  sendText(_text: string): void { throw new Error('Gemini Live is disabled'); }
  disconnect(): void {}
}
