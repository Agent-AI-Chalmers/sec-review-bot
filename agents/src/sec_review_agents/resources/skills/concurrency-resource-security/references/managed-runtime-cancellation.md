# Java And .NET Cooperative Cancellation

- Java `Future.cancel(true)` and executor shutdown are best-effort; active work commonly depends on interruption and task cooperation. Verify whether blocking operations and loops observe interruption and release resources.
- .NET cancellation tokens carry cooperative notification. Distinguish canceling the operation from canceling only the wait; abandoned operations can continue to hold resources or produce side effects.
- Trace token/interruption propagation, ownership of token sources/executors, cleanup and bounded admission. A canceled task status does not prove every underlying operation stopped.

Apply the repository's runtime/API version. Report only a reachable cancellation or shutdown path with concrete retained work, leaked authority or service impact.
