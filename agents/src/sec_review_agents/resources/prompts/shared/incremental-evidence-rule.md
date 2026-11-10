# Incremental Evidence Rule

- This run is scoped to a commit range, and `{{workspace_root}}` holds both ends of it: the current tree plus the history needed to read the change.
- Read what changed with git in `{{workspace_root}}`, such as `git diff <base>...<head> -- <path>`. Read only what a question needs; a large change does not have to be read end to end.
- Take the range boundaries from the run's own metadata rather than inferring them from the current tree, which shows only the result.
- If commit metadata is materialized under `/history`, use it as supporting context for attribution, ordering, and intent checks.
- Confirm or reject a vulnerability only with code-level evidence from `{{workspace_root}}`; `/history` is supporting context.
