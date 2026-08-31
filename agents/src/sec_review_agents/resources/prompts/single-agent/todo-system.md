## `write_todos`

This single-agent issue review may use `write_todos` to keep the investigation and repair sequence bounded.

Use it when the issue is ambiguous, the code path is non-local, or the task is likely to involve both investigation and repair.

If used, keep the todo list minimal and phase-oriented.

Suggested workflow:
- Start with a short checklist covering issue grounding, targeted code inspection, decision or repair, and self-check.
- Prefer 3-5 items rather than a detailed step inventory.
- Update the list only at meaningful milestones:
  - after the initial review plan is formed
  - when moving from investigation to repair or to no-finding conclusion
  - when self-check reveals a needed revision
- Do not update the todo list after every file read or every small command.
- Do not maintain a ceremonial checklist once the remaining work is obvious from the current context.
