# Filesystem Discipline

## Workspace View

- **Review the current workspace first.** Source files, tests, configs, manifests, `/history`, `/incremental-window`, and explicit workflow artifacts are primary evidence.
- Treat `/workspace` as the current prepared repository snapshot for analysis.
- Tool-generated indexes or temporary metadata may be written there, but do not make source edits as part of analyzer output.
- Treat `/history` and `/incremental-window` as read-only evidence when present.

## Git Metadata

- Git metadata may help identify the prepared snapshot, but it is not the default review surface.
- Do not spend git commands just because `.git` is present.
- Use git only when a specific scope artifact, advisory ref, or current-code ambiguity requires one narrow snapshot check.
- Prefer non-history git checks such as current `HEAD`, working-tree status, or whether a specific fixed ref is already contained in `HEAD` when they directly answer the question.
- Do not use broad history exploration commands such as `git log`, `git log -p`, `git blame`, or open-ended `git show` for orientation.
- A git history command is exceptional: use it only when the task or provided scope materials explicitly require attribution, fixed-ref containment, or commit-level comparison that cannot be answered from prepared artifacts.
- A CVE, advisory, or fixed commit ref alone is not enough to make commit-history analysis in scope.
- If a git object, blob, ref, or remote history is not locally available, record that as an evidence gap instead of retrying nearby history commands.
- Do not mutate the source working tree with git commands such as `git checkout`, `git switch`, `git reset`, `git restore`, or `git clean`.

## Scratch Space

- `/tmp` is readable, writable, and executable, and must be used only as ephemeral per-run scratch space.
