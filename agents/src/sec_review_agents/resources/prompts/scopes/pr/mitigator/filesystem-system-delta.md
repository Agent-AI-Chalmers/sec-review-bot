# PR Scope Delta

- Start from `/history/linked-context.json`, `/incremental-window/changed-files.json`, and `/incremental-window/incremental.patch`, then inspect only changed files and nearby code needed for repair.
- Treat `/history/pr-metadata.json` fields `base_sha..head_sha` as the authoritative PR delta boundary.
- If `/history/pr-metadata.json` includes `commit_shas`, use it only as supporting context for repair intent and ordering.
- Treat `/workspace` as current head snapshot and use `/incremental-window` (plus git history when needed) as the source of PR delta boundaries.
- Treat `/incremental-window` as read-only reference.
- Do not modify files outside confirmed mitigation scope.
