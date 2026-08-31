# Workspace Evidence Rule

- The prepared agent workspace is a materialized local repository for this run and may include git metadata and commit history.
- Treat `/workspace` as prepared code state for this run, not as a repository-history review surface by default.
- `.git` metadata may exist as a materialization detail; its presence does not by itself make commit history in scope.
- Infer "what changed" from explicit change artifacts and/or git evidence provided by the active scope.
- Prefer artifacts intentionally materialized for review by the active workflow (for example scope metadata, history context, incremental artifacts, and `workspace_patch` when available).
- Use `read_file` for file contents and rely on scope-specific delta artifacts for change review.
- Use `execute` when you need targeted runtime evidence that cannot be obtained from the prepared artifacts alone.
