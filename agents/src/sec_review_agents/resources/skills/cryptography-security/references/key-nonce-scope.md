# Key, Nonce And Randomness Scope

- Determine the exact primitive or mode. Uniqueness, unpredictability and secrecy are different requirements.
- For GCM, assess IV uniqueness within a key's invocation scope. Reuse under the same key is dangerous; a deterministic counter can be valid when uniqueness, persistence and wrap handling are established.
- Key separation can change whether equal nonce values collide in the relevant scope. Prove the key relationship rather than comparing nonce bytes alone.
- Treat RNG calls, timestamps and counters as leads until their required property and scope are known.

Report only when the repository violates the actual primitive contract on a feasible path. Preserve uncertainty when key identity, state persistence or concurrency behavior is unknown.
