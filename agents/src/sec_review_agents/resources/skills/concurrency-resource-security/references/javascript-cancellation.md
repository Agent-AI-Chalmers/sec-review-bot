# JavaScript Cancellation And Retained Work

- Promise rejection or abandonment does not cancel underlying I/O or sibling promises. Verify whether the API accepts an `AbortSignal` and whether it is propagated to every operation that should stop.
- `Promise.all()` rejects after one failure while other work may continue. Connect continued work to retained resources, side effects or attacker-amplified capacity before reporting.
- Cleanup constructs and `finally` cover only resources actually owned by that scope; an abort request is not proof that a library operation stopped.

Do not infer a vulnerability from a missing `AbortController` alone. Establish attacker-triggered retention or unintended effects and the API's actual abort semantics.
