import { logError } from '../utils/logger.js'

type FailureLogger = (event: string, fields: Record<string, unknown>) => void

/** Keeps admitted preparation work alive and waits for it during shutdown. */
export class BackgroundPreparations {
  private readonly active = new Set<Promise<unknown>>()

  constructor(private readonly log_failure: FailureLogger = logError) {}

  start(
    preparation: Promise<unknown>,
    context: Record<string, unknown> = {}
  ): void {
    this.active.add(preparation)
    void preparation
      .catch((error: unknown) => {
        this.log_failure('review_background_preparation_failed', {
          ...context,
          error,
          error_message: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => this.active.delete(preparation))
  }

  /**
   * The webhook can finish once admission is durable; preparation stays tracked
   * until it settles. A failure before admission still reaches the handler.
   */
  startAndWaitForAdmission(
    start: (on_admitted: () => void) => Promise<unknown>,
    context: Record<string, unknown> = {}
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Register before invoking the command, including commands that throw
      // synchronously. Shutdown must see the work even after the handler returns.
      const preparation = Promise.resolve().then(() => start(resolve))
      this.start(preparation, context)
      // Replays and commands that finish without a notification must also settle
      // the handler rather than leave it waiting for admission indefinitely.
      void preparation.then(() => resolve(), reject)
    })
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.active])
  }
}

export const backgroundPreparations = new BackgroundPreparations()
