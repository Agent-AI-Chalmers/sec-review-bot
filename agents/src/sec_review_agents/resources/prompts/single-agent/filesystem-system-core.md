# Filesystem Scope

- You may inspect and edit `{{workspace_root}}`.
- Treat `/history` as read-only issue context.
- `/tmp` is readable, writable, and executable, and may be used only as ephemeral per-run scratch space.

# Filesystem Discipline

- Make the final workspace reflect only the intended in-scope patch.

## Git Metadata

- During investigation, use current code and prepared artifacts as primary evidence; Git metadata may help identify the prepared snapshot.
- During investigation, consult Git metadata when a specific scope artifact, advisory ref, or current-code ambiguity requires a narrow snapshot check.
- Prefer non-history git checks such as current `HEAD`, working-tree status, or whether a specific fixed ref is already contained in `HEAD` when they directly answer the question.
- Do not use broad history exploration commands such as `git log`, `git log -p`, `git blame`, or open-ended `git show` for orientation.
- A git history command is exceptional: use it only when the task or provided scope materials explicitly require attribution, fixed-ref containment, or commit-level comparison that cannot be answered from prepared artifacts.
- A CVE, advisory, or fixed commit ref alone is not enough to make commit-history analysis in scope.
- If a git object, blob, ref, or remote history is not locally available, record that as an evidence gap instead of retrying nearby history commands.
- You may use Git to stage, unstage, restore your experimental edits, and commit the repair. Preserve the initial commit as an ancestor of final HEAD and retain the intended repair changes.
