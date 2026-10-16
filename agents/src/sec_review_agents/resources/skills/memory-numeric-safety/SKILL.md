---
name: memory-numeric-safety
description: "Use when security depends on integer conversion or overflow, allocation/access units, object lifetime, pointer validity, or unsafe/FFI preconditions. Do not infer a flaw from a length field or unsafe block alone."
---

# Memory And Numeric Safety

Use this skill to establish the exact value and object consumed after language conversions, allocation arithmetic, ownership transfer, and unsafe boundaries.

- For integer width, signedness, conversions, element/byte units, allocation and access bounds: read `/skills/memory-numeric-safety/references/numeric-semantics-and-bounds.md`.
- For initialization, lifetime, ownership, dangling objects and invalid frees: read `/skills/memory-numeric-safety/references/object-validity.md`.
- For unsafe code, raw pointers, representation, alignment and FFI contracts: read `/skills/memory-numeric-safety/references/unsafe-ffi.md`.

Require repository evidence for operand types, relevant language/build semantics, the consumed value or object, attacker influence, and security effect. A suspicious operation without violated preconditions is not a confirmed vulnerability.
