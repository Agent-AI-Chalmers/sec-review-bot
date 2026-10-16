# Unsafe And FFI Contracts

## Analysis

- Identify the exact unsafe operation and the obligations it places on callers: valid address range, alignment, initialization, lifetime, aliasing, mutability and thread access.
- At FFI boundaries, verify ABI, layout, calling convention, ownership transfer and which side allocates or releases storage.
- Trace safe wrappers to the unsafe primitive. A safe public API can still violate an internal contract; an unsafe API can be correct when all preconditions are enforced.
- Treat foreign callbacks as possible lifetime and reentrancy boundaries only when the callback can actually occur on the reviewed path.

## Report Conditions

Show the violated precondition, the repository path that violates it, the later invalid operation, and the security-relevant consequence.

## Counterexamples And Unknowns

- `unsafe`, `extern`, raw pointers, casts and layout attributes are not findings by themselves.
- Preserve uncertainty when the foreign API version, ownership convention, target ABI or wrapper invariant is unavailable.
