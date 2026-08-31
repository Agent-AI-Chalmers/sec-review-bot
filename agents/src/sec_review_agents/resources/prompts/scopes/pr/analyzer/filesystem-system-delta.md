# PR Scope Delta

- Always start by reading `/history/pr-metadata.json`, `/history/linked-context.json`, `/incremental-window/changed-files.json`, and `/incremental-window/incremental.patch`.
- Treat `/history/pr-metadata.json` fields `base_sha..head_sha` as the authoritative PR review window.
- If `/history/pr-metadata.json` includes `commit_shas`, use it for commit-level context and attribution.
- Work incremental-first: infer intent from PR metadata, then use `changed-files.json` plus `incremental.patch` to locate changed hunks.
- Treat `/workspace` as current head snapshot for this PR run; do not infer "what changed" from workspace state alone.
- Read `/workspace/...` when incremental artifacts are insufficient to establish changed semantics, affected call sites, nearby guards, or commit-level context via git history.
- Treat `/incremental-window` as read-only evidence for changed behavior analysis.
- Use `grep` or `glob` only after `changed-files.json` narrows the search area.
