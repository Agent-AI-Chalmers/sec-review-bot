# Concurrency And Resource Security Source Notes

Reviewed 2026-10-16. Temporal correctness and resource exhaustion remain separate references. Language, database and API-specific synchronization, cancellation and cleanup still require primary documentation.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| CON-1: conflicting access; `temporal-invariants.md` | [SEI CERT C Concurrency](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/concurrency-con/), CON43-C | Inspect conflicting operations and synchronization coverage rather than lock presence. C data-race rules do not define database semantics. |
| CON-2: lifetime across threads; `temporal-invariants.md` | Same source, CON34-C | Object lifetime must cover concurrent access. Require a feasible interleaving and reachable invalid use. |
| CON-3: check/use invalidation; `temporal-invariants.md` | [MITRE CWE-367](https://cwe.mitre.org/data/definitions/367.html), Description and Potential Mitigations | A check can become invalid when an actor alters state. Separate calls alone do not prove attacker control or impact. |
| RES-1: attacker-driven consumption; `resource-budgets.md` | [CWE-400](https://cwe.mitre.org/data/definitions/400.html), Description and consequences; [CWE-770](https://cwe.mitre.org/data/definitions/770.html), Description and mitigations | Relate cost, amplification, rate, concurrency, capacity and recovery. Missing timeout or quota alone is insufficient. |
| RES-2: cleanup accumulation; `resource-budgets.md` | [SEI CERT C Memory Management](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/), MEM31-C; CWE-400 | Follow acquisition and reachable cleanup paths. Descriptor, task and cancellation semantics remain API-specific. |
| PYASYNC-1: cancellation cleanup; `python-asyncio-cancellation.md` | [Python 3.14 Coroutines and Tasks](https://docs.python.org/3.14/library/asyncio-task.html), task cancellation and `TaskGroup` | Cancellation raises `CancelledError` at an await point; cleanup should use `try/finally`, and suppressing cancellation can disrupt structured-concurrency behavior. Apply only to the repository's Python version. |
| PYASYNC-2: queue backpressure; `python-asyncio-cancellation.md` | [Python 3.14 Asyncio Queues](https://docs.python.org/3.14/library/asyncio-queue.html), `Queue(maxsize)` and timeout note | Positive `maxsize` blocks `put()` when full; zero is unbounded. Verify surrounding admission and timeout behavior before claiming exhaustion. |
| PYASYNC-3: semaphore scope; `python-asyncio-cancellation.md` | [Python 3.14 Synchronization Primitives](https://docs.python.org/3.14/library/asyncio-sync.html), `Semaphore` and `BoundedSemaphore` | A semaphore only bounds paths using the same instance and correct release ownership. Presence alone is not proof of effective admission. |
| JS-1: abort propagation; `javascript-cancellation.md` | [WHATWG DOM, AbortController and AbortSignal](https://dom.spec.whatwg.org/#aborting-ongoing-activities); [MDN Promise.all](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all) | Promise settlement does not itself cancel underlying work. Require an API that supports abort, missing propagation, and concrete retained work or effects. |
| MANAGED-1: Java interruption and .NET cancellation; `managed-runtime-cancellation.md` | [Java Future](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Future.html#cancel(boolean)); [.NET cancellation](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads) | Both models are cooperative and API-specific. A canceled wrapper state is not proof that the underlying operation stopped. |
| GO-1: context and goroutine lifetime; `go-context-cancellation.md` | [Go context package](https://pkg.go.dev/context); [Go blog: Pipelines and cancellation](https://go.dev/blog/pipelines) | Propagate contexts and make blocked goroutines observe cancellation. Missing timeout or a `go` statement alone is insufficient without reachable retention and impact. |

Unknown production capacity can remain a proof gap, but exact measurement is unnecessary when code establishes unbounded attacker-controlled retention and service impact.

Behavior cases for Python cancellation: `asyncio-cancellation-permit-leak` (confirmed and natural discovery), `asyncio-cancellation-finally-release` (counterexample), and `asyncio-cancellation-unknown` (unresolved boundary).

Additional behavior cases: `javascript-abort-not-propagated`, `managed-cancellation-unknown`, and `go-goroutine-cancellation-leak`.

## Coverage and exclusions

Current coverage: conflicting operations, temporal invariants, check/use invalidation, attacker-driven resource budgets, accumulating cleanup failures, and cancellation/lifetime rules for Python asyncio, JavaScript, Java/.NET and Go. Language memory models require their own specifications when they change a repository decision. Lock-order catalogs and distributed-consensus correctness remain workflow reasoning unless a stable security rule is identified. A deadlock or retry loop belongs here only when it creates a concrete security effect.
