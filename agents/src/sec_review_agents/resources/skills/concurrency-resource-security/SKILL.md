---
name: concurrency-resource-security
description: "Use when security depends on interleaving, atomicity, synchronization coverage, cancellation, cleanup, or attacker-driven finite-resource consumption. Lock presence or a missing timeout alone is not proof."
---

# Concurrency And Resource Security

- For races, check/use invalidation, atomic state transitions, conflicting access and lifetime across interleavings: read `/skills/concurrency-resource-security/references/temporal-invariants.md`.
- For admission, amplification, retained work, cleanup, cancellation and capacity effects: read `/skills/concurrency-resource-security/references/resource-budgets.md`.
- For Python `asyncio` task cancellation, `TaskGroup`, bounded queues, semaphores and cancellation-safe cleanup: read `/skills/concurrency-resource-security/references/python-asyncio-cancellation.md`.
- For JavaScript promises, abort signals and work that continues after promise rejection: read `/skills/concurrency-resource-security/references/javascript-cancellation.md`.
- For Java interruption/Future cancellation and .NET cancellation tokens: read `/skills/concurrency-resource-security/references/managed-runtime-cancellation.md`.
- For Go contexts, goroutine/channel cancellation and leaked derived contexts: read `/skills/concurrency-resource-security/references/go-context-cancellation.md`.

Keep temporal correctness and resource cost as separate claims unless the evidence connects them.
