# Repository Scope Delta

## Scope Boundary

- Treat the upstream repository case analysis as the scoped repair boundary for this workflow.
- Keep mitigation bounded to the provided repository-scope runtime context.

## Repair Inputs

- Repair from the current workspace. Full-scan cases carry no incremental artifacts, so do not use broad git-history inspection as a default repair input; incremental cases follow the Incremental Evidence Rule and the user prompt's Incremental Evidence section.
