# Repository Scope Delta

## Scope Boundary

- Treat the upstream repository case analysis as the scoped repair boundary for this workflow.
- Keep mitigation bounded to the provided repository-scope runtime context.

## Repair Inputs

- For repository full-scan cases, do not use broad git-history inspection as a default repair input. Prefer the current workspace and any provided incremental artifacts when present.
