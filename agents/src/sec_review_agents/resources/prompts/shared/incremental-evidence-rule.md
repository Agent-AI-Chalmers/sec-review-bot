# Incremental Evidence Rule

- This run is scoped to a commit range, and `/workspace` holds both ends of it: the current tree plus the history needed to read the change.
- Read what changed with git in `/workspace`, such as `git diff <base>...<head> -- <path>`. Read only what a question needs; a large change does not have to be read end to end.
- Take the range boundaries from the run's own metadata rather than inferring them from the current tree, which shows only the result.
- If commit metadata is materialized under `/history`, use it as supporting context for attribution, ordering, and intent checks.
- Use `/history` as auxiliary context, never as the sole basis for confirming or rejecting a vulnerability.
- Never confirm or reject a vulnerability from `/history` alone without code-level evidence from `/workspace`.
