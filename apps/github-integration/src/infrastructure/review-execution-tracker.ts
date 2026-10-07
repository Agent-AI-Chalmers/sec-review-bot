import { logError } from '../utils/logger.js'

type FailureLogger = (event: string, fields: Record<string, unknown>) => void

/** Tracks admitted in-process preparation work so shutdown does not abandon it. */
export class ReviewExecutionTracker {
  private readonly active = new Set<Promise<unknown>>()

  constructor(private readonly log_failure: FailureLogger = logError) {}

  start(execution: Promise<unknown>, context: Record<string, unknown> = {}): void {
    this.active.add(execution)
    void execution
      .catch((error: unknown) => {
        this.log_failure('review_background_execution_failed', {
          ...context,
          error,
          error_message: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => this.active.delete(execution))
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.active])
  }
}

export const reviewExecutionTracker = new ReviewExecutionTracker()
