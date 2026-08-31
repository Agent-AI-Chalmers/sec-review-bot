# PR Scope Delta

- Start by reading `/history/pr-metadata.json`, `/history/linked-context.json`, `/incremental-window/changed-files.json`, and `/incremental-window/incremental.patch`.
- Treat `/history/pr-metadata.json` fields `base_sha..head_sha` as the authoritative PR verification window.
- If `/history/pr-metadata.json` includes `commit_shas`, use it for commit-level consistency checks.
- Use `changed-files.json` plus `incremental.patch` to validate what changed in the pull request.
- Treat `/workspace` as current head snapshot; use git history only as supporting evidence for PR delta interpretation.
- Treat `/incremental-window` and `/history` as read-only verification context.
