# Memory And Numeric Safety Source Notes

Reviewed 2026-10-16. Language rules remain language-specific; examples from C and Rust establish mechanisms, not a universal API blacklist.

| ID and skill location | Primary source and locator | Supported decision and limit |
| --- | --- | --- |
| MEM-1: integer behavior; `numeric-semantics-and-bounds.md` | [SEI CERT C Integers](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/integers-int/), INT30-C, INT31-C and INT32-C; [Rust overflow](https://doc.rust-lang.org/reference/expressions/operator-expr.html#overflow) | Establish widths, signedness, conversions and overflow behavior before deciding whether a guard constrains the consumed value. Do not generalize C promotions or Rust build behavior. |
| MEM-2: allocation/access units; `numeric-semantics-and-bounds.md` | [SEI CERT C Memory Management](https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/), MEM35-C | Relate element count, byte count, capacity and actual access. A length field or multiplication alone is not a vulnerability. |
| MEM-3: non-memory consequences; `numeric-semantics-and-bounds.md` | [MITRE CWE-704](https://cwe.mitre.org/data/definitions/704.html), Description and Common Consequences | Conversion errors can affect protection logic without memory access. The security importance of a quota, timeout or range remains repository-specific. |
| MEM-4: lifetime and invalid free; `object-validity.md` | SEI CERT C Memory Management, MEM30-C and MEM34-C | Trace ownership, release and later reachable use. Cleanup syntax alone does not prove a dangling use or invalid free. |
| MEM-5: unsafe validity; `unsafe-ffi.md` | [Rust undefined behavior](https://doc.rust-lang.org/reference/behavior-considered-undefined.html), dangling/misaligned pointers, invalid values, data races and foreign ABI | Unsafe operations require specific validity, alignment, lifetime and ABI preconditions. `unsafe`, raw pointers or FFI alone are not proof. |

Project policy requires the violated semantic contract, actual consumer and concrete security consequence. Unknown types, ownership or ABI remain proof gaps.
