---
name: concurrency-resource-security
description: "Use when security depends on interleaving, atomicity, synchronization coverage, cancellation, cleanup, or attacker-driven finite-resource consumption. Lock presence or a missing timeout alone is not proof."
---

# Concurrency And Resource Security

- For races, check/use invalidation, atomic state transitions, conflicting access and lifetime across interleavings: read `/skills/concurrency-resource-security/references/temporal-invariants.md`.
- For admission, amplification, retained work, cleanup, cancellation and capacity effects: read `/skills/concurrency-resource-security/references/resource-budgets.md`.

Keep temporal correctness and resource cost as separate claims unless the evidence connects them.
