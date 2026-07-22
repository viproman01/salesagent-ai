import type {
  ModelCandidate,
  ModelRunner,
  ModelRunnerRequest,
} from '../orchestrator';

export type FallbackModelRunnerOptions = Readonly<{
  primary: ModelRunner;
  fallback: ModelRunner;
  now?: () => number;
  onFallback?: (error: unknown) => void;
}>;

/**
 * Tries the secondary provider only while the original tier deadline still has
 * budget. Cancellation is terminal so barge-in can never start a fresh call.
 */
export class FallbackModelRunner implements ModelRunner {
  readonly name: string;
  private readonly options: FallbackModelRunnerOptions;
  private readonly now: () => number;

  constructor(options: FallbackModelRunnerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.name = `${options.primary.name}->${options.fallback.name}`;
  }

  async run(request: ModelRunnerRequest): Promise<ModelCandidate> {
    try {
      return await this.options.primary.run(request);
    } catch (error) {
      if (request.signal.aborted || this.now() >= request.deadlineAtMs) {
        throw error;
      }

      try {
        this.options.onFallback?.(error);
      } catch {
        // Observability must not prevent the safe provider fallback.
      }
      return this.options.fallback.run(request);
    }
  }
}
