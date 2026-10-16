# Resource Budgets And Cleanup

- Relate attacker-controlled work to per-request cost, amplification, rate, concurrency, capacity, retention and recovery.
- Follow acquisition, error, cancellation and retry paths when unreleased resources can accumulate.
- Account for effective admission controls, bounded queues, quotas, timeouts and cleanup guarantees using the actual API semantics.

Missing limits or cleanup calls alone are leads. Confirm a credible service effect; when production capacity or release behavior is unknown, record the proof gap instead of inventing exhaustion.
