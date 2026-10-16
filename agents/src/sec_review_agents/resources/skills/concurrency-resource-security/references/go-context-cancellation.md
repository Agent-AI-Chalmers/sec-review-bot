# Go Context And Goroutine Cancellation

- Propagate request contexts across API boundaries. Derived contexts created with cancellation, deadline or timeout must have their cancel function called so parent references and timers are released.
- Goroutines blocked on channel send/receive need a cancellation path when downstream consumers can stop early. A returned handler does not automatically stop goroutines it started.
- Separate context cancellation from operation completion: a cancel function signals work to stop but does not wait for it.

Report only when attacker-triggered requests or error paths can retain goroutines, timers, connections or capacity with concrete effect. A `go` statement or missing timeout alone is insufficient.
