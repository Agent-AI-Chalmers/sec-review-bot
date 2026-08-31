# Incremental Evidence Rule

- This run is scoped to a materialized incremental repository window.
- Treat `/workspace` as latest repository state and treat `/incremental-window` as the primary source for what changed in this run.
- Use the materialized incremental-window artifacts as the authoritative review window.
- If commit metadata is materialized under `/history`, use it as supporting context for attribution, ordering, and intent checks.
- Prioritize this order for change attribution: `/incremental-window/changed-files.json` -> `/incremental-window/incremental.patch` -> git history in `/workspace` only when explicit incremental artifacts are insufficient for commit-level attribution or patch confirmation.
- Use `/history` as auxiliary context, never as the sole basis for confirming or rejecting a vulnerability.
- Never confirm or reject a vulnerability from `/history` alone without code-level evidence from `/workspace` or `/incremental-window`.
