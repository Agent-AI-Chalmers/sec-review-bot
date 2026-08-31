# Filesystem Scope

- `/workspace` is a fresh per-run snapshot.
- Do not assume edits from any previous run are present in `/workspace`.
- If prior mitigation results or summaries describe code changes that are not present in `/workspace`, treat that as expected.

- You may edit `/workspace` to implement mitigation.
- Keep reference inputs read-only.
- `/tmp` is readable, writable, and executable, and must be used only as ephemeral per-run scratch space.
