# Java Memory Model And Security State

- Establish a happens-before edge for shared mutable state whose visibility or ordering affects authorization, revocation, initialization or resource ownership. Program order in one thread does not publish ordinary writes to another thread.
- Monitor unlock/lock, volatile write/read, thread start and successful join create documented happens-before relationships. A nearby synchronized block or an unrelated volatile field does not publish arbitrary state.
- Distinguish stale or partially published state from a merely theoretical data race. Report only a feasible execution that changes a security decision or retains security-relevant authority.
- Immutable state safely constructed and published through a documented synchronization mechanism is a counterexample. Apply the Java Language Specification for the repository's Java target.

Do not infer exploitability from a non-volatile field alone. Identify the writer, reader, missing publication edge, attacker timing or influence, and concrete effect.
