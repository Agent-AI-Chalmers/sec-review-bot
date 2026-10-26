export class RefreshQueue {
  private running = false
  private queued = false
  private activeWaiters: Array<() => void> = []
  private queuedWaiters: Array<() => void> = []

  constructor(
    private readonly run: () => Promise<void>,
    private readonly onRunningChange: (running: boolean) => void = () => {},
    private readonly onAttemptSettled: () => void = () => {}
  ) {}

  request(): Promise<void> {
    let shouldStart = false
    const completion = new Promise<void>((resolve) => {
      if (this.running) {
        this.queued = true
        this.queuedWaiters.push(resolve)
      } else {
        this.running = true
        this.activeWaiters = [resolve]
        shouldStart = true
      }
    })
    if (shouldStart) void this.drain()
    return completion
  }

  private async drain(): Promise<void> {
    this.notify(() => this.onRunningChange(true))
    for (;;) {
      try {
        await this.run()
      } catch {
        // Query owners retain their error state; queue completion means the attempt settled.
      } finally {
        this.notify(this.onAttemptSettled)
        for (const resolve of this.activeWaiters) resolve()
      }
      if (!this.queued) break
      this.queued = false
      this.activeWaiters = this.queuedWaiters
      this.queuedWaiters = []
    }
    this.activeWaiters = []
    this.running = false
    this.notify(() => this.onRunningChange(false))
  }

  private notify(notification: () => void): void {
    try {
      notification()
    } catch {
      // Notifications update optional presentation state. Their failures must not strand
      // refresh callers or corrupt the queue's running and waiter bookkeeping.
    }
  }
}
