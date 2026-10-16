# Concurrency And Resource Security Source Notes

Reviewed 2026-10-16. Temporal correctness and resource exhaustion remain separate references. Language, database and API-specific synchronization, cancellation and cleanup still require primary documentation.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| CON-1: conflicting access; `temporal-invariants.md` | [SEI CERT C Concurrency](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/concurrency-con/), CON43-C | Inspect conflicting operations and synchronization coverage rather than lock presence. C data-race rules do not define database semantics. |
| CON-2: lifetime across threads; `temporal-invariants.md` | Same source, CON34-C | Object lifetime must cover concurrent access. Require a feasible interleaving and reachable invalid use. |
| CON-3: check/use invalidation; `temporal-invariants.md` | [MITRE CWE-367](https://cwe.mitre.org/data/definitions/367.html), Description and Potential Mitigations | A check can become invalid when an actor alters state. Separate calls alone do not prove attacker control or impact. |
| RES-1: attacker-driven consumption; `resource-budgets.md` | [CWE-400](https://cwe.mitre.org/data/definitions/400.html), Description and consequences; [CWE-770](https://cwe.mitre.org/data/definitions/770.html), Description and mitigations | Relate cost, amplification, rate, concurrency, capacity and recovery. Missing timeout or quota alone is insufficient. |
| RES-2: cleanup accumulation; `resource-budgets.md` | [SEI CERT C Memory Management](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/), MEM31-C; CWE-400 | Follow acquisition and reachable cleanup paths. Descriptor, task and cancellation semantics remain API-specific. |

Unknown production capacity can remain a proof gap, but exact measurement is unnecessary when code establishes unbounded attacker-controlled retention and service impact.

## Coverage and deferred work

Current coverage: conflicting operations, temporal invariants, check/use invalidation, attacker-driven resource budgets and accumulating cleanup failures. Deferred: language-specific memory models, lock-order/deadlock catalogs, distributed consensus correctness and API-specific cancellation guarantees. A deadlock or retry loop belongs here only when it creates a concrete security effect.
