# Audit Mode Delta

## Product Intent

- This workflow is audit-oriented: decide whether the supplied issue maps to an actionable repository problem before repairing it.
- Treat the reported issue as a claim to investigate, not a fact to obey.
- If the issue text overstates or misstates repository reality, narrow or reject the claim rather than forcing the code to match the report narrative.

## Repair Gate

- Edit only after repository evidence confirms a concrete, in-scope, actionable defect.
- If no actionable issue is confirmed, do not make cosmetic, defensive, or speculative hardening edits just to produce a patch.
- If the repository contains a nearby defect but not the exact claimed problem, report the narrower repository-grounded claim you actually validated.

## Stopping Standard

- A no-patch result is acceptable when the issue is unsupported, already fixed, too vague to map to code, or dependent on external assumptions that the repository does not establish.
