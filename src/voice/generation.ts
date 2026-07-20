import type { TurnRef } from './providers/tts';

export type VoiceGenerationLease = Readonly<{
  turn: TurnRef;
  signal: AbortSignal;
}>;

/**
 * Owns the monotonically increasing generation for one call.
 * Starting a new turn or interrupting the current one invalidates all older work.
 */
export class VoiceGenerationController {
  private generation = 0;
  private current:
    | {
        turn: TurnRef;
        controller: AbortController;
      }
    | undefined;

  constructor(
    private readonly callId: string,
    private readonly conversationId: string
  ) {}

  startTurn(turnId: string): VoiceGenerationLease {
    if (!turnId.trim()) {
      throw new Error('turnId is required');
    }

    this.current?.controller.abort('superseded');
    const controller = new AbortController();
    const turn: TurnRef = Object.freeze({
      callId: this.callId,
      conversationId: this.conversationId,
      turnId,
      generation: ++this.generation,
    });

    this.current = { turn, controller };
    return { turn, signal: controller.signal };
  }

  interrupt(reason = 'interrupted'): void {
    if (!this.current) return;

    this.current.controller.abort(reason);
    this.current = undefined;
    this.generation++;
  }

  isCurrent(turn: TurnRef): boolean {
    return (
      this.current !== undefined &&
      !this.current.controller.signal.aborted &&
      sameTurn(this.current.turn, turn)
    );
  }
}

export function sameTurn(left: TurnRef, right: TurnRef): boolean {
  return (
    left.callId === right.callId &&
    left.conversationId === right.conversationId &&
    left.turnId === right.turnId &&
    left.generation === right.generation
  );
}
