# Object Validity And Lifetime

## Analysis

- Establish initialization, lifetime, ownership transfer and aliasing requirements for the actual language and object model.
- Follow cleanup and error paths when they can leave a reachable dangling object or repeated invalid use.
- Distinguish freeing owned storage from releasing borrowed, static, stack or already-freed storage.

## Report Conditions

Identify the invalid object state, the feasible path that creates it, the later use, attacker influence where required, and the concrete effect.

## Counterexamples And Unknowns

- A cleanup call followed by no reachable use is not a use-after-free.
- Do not invent ownership facts absent from code or authoritative API documentation.
