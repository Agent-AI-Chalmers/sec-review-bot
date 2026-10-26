export interface LatestRequest {
  readonly signal: AbortSignal
  isCurrent(): boolean
  cancel(): void
}

/** Owns the latest request for one component query. Abort reduces unnecessary work; the
 * generation check remains the correctness boundary when an async implementation ignores abort. */
export class LatestRequestGuard {
  private generation = 0
  private controller: AbortController | undefined

  begin(): LatestRequest {
    this.controller?.abort()
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    return {
      signal: controller.signal,
      isCurrent: () =>
        generation === this.generation && !controller.signal.aborted,
      cancel: () => controller.abort()
    }
  }
}
