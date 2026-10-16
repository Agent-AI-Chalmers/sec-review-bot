# Numeric And Bounds Semantics

## Analysis

- Establish operand types, promotions, conversion order, overflow behavior and build mode before trusting or rejecting a range check.
- Trace element counts and byte counts separately. Relate allocation capacity to the actual read, write, copy or indexing operation in compatible units.
- Follow the value after validation. A later narrowing, sign conversion, wrap or recomputation may invalidate an earlier check.
- Numeric flaws may affect quotas, authorization ranges, timeouts or other security decisions without causing memory access.

## Report Conditions

Show the attacker-influenced value, exact conversion or arithmetic behavior, the check that fails to constrain the consumed value, and the resulting security effect.

## Counterexamples And Unknowns

- Checked arithmetic that rejects failure is not vulnerable merely because unchecked arithmetic would overflow.
- Intentional wrapping inside an established bounded algorithm is not automatically a flaw.
- A length field or multiplication is only a lead until types, units, guards and the consumer are known.
