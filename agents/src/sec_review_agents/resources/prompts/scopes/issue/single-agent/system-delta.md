# Issue Scope Delta

## Scope Boundary

- Treat the provided issue text and the prepared repository workspace as the primary review scope for this workflow.
- You are not receiving an upstream analyzer result; you must establish the actionable claim yourself from repository evidence.

## Review Inputs

- Use the issue text and the inspected repository code as your primary evidence sources.
- In this workflow, broad git-history exploration is not a substitute for repository-grounded review of the prepared workspace.
- Start by reading `/history/issue-metadata.json` and `/history/linked-context.json`, then form the narrowest current claim before widening repository reads.
- If the issue framing is broad or historically loaded, use the working state and, when needed, a short todo checklist to keep the review bounded to one concrete claim at a time.

## Decision Standard

- Let the active mode delta decide how much weight to give the issue text as a repair lead versus a claim to verify.
- Report the strongest repository-grounded claim you actually validated or repaired under that mode.
