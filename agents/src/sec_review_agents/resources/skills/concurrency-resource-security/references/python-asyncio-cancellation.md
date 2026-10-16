# Python Asyncio Cancellation And Backpressure

- Cancellation is delivered by raising `CancelledError` in the task at an await point. Use `try/finally` or an ownership construct that releases acquired resources when cancellation interrupts work.
- Code that catches `CancelledError` should normally complete cleanup and propagate cancellation. Suppressing it can defeat `TaskGroup`, timeout and shutdown behavior; confirm the actual retained task or resource effect before reporting.
- `TaskGroup` cancels remaining tasks after a non-cancellation failure and waits for them. Inspect child cleanup and exception handling rather than assuming group syntax makes every operation cancellation-safe.
- `asyncio.Queue(maxsize)` applies backpressure when full; `maxsize=0` is unbounded. Queue methods do not take timeout parameters, so verify any surrounding timeout or admission mechanism.
- Semaphores bound concurrent entry only when all acquisition and release paths share the same semaphore and cancellation cannot leak permits.

Report only when attacker-controlled requests or shutdown/error paths can trigger cancellation, retention or admission failure with a concrete service effect. API names or a missing timeout alone are insufficient.
