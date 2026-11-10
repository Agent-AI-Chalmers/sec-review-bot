# Incremental Window Scope Rule

- This run is scoped to the materialized incremental repository window.
- Treat `{{workspace_root}}` as current head code and derive incremental causality from what git shows changed in the run's commit range, read on demand rather than end to end.
- Report only findings that are plausibly introduced, reactivated, or materially changed by edits inside the incremental window.
- If a finding appears pre-existing and unchanged by the incremental window, treat it as outside this run's scope rather than as an incremental result.
- Do not report a finding in incremental mode solely because the vulnerability class exists in the repository; tie the reported result to changed files, changed hunks, or behavior changed by the incremental window.
- If causality to the incremental window is uncertain but plausible from changed evidence, prefer reporting it with explicit uncertainty over confidently classifying it as unrelated.
- When you set a finding aside as out of window, state that rationale explicitly.
