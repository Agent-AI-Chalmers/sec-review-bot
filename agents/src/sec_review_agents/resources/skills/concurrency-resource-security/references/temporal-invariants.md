# Temporal Invariants

- Identify the invariant, all conflicting operations and the synchronization or transaction coverage around them. A lock elsewhere does not establish coverage.
- For check/use claims, prove that a relevant actor can change the checked state before use and that the change defeats a security property.
- Include asynchronous, transactional and multi-process interleavings when the runtime permits them; do not assume threads are the only source of interleaving.

Separate calls or non-atomic code alone are insufficient. A correctly atomic consume, stable object or inaccessible competing writer is a counterexample.
