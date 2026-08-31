# Incremental Window Scope Rule

- This run is scoped to the materialized incremental repository window.
- Triage for the materialized incremental window only.
- Treat `/workspace` as current head code and derive incremental causality from `/incremental-window/incremental.patch` and `/incremental-window/changed-files.json` first; use git history only when those explicit artifacts are insufficient for attribution, ordering, or patch confirmation.
- Keep only findings/cases that are plausibly introduced, reactivated, or materially changed by edits inside the incremental window.
- If a finding appears pre-existing and unchanged by the incremental window, suppress or skip it rather than keeping it as an incremental result.
- Do not keep a candidate/case in incremental mode solely because the vulnerability class exists in the repository; tie the kept result to changed files, changed hunks, or behavior changed by the incremental window.
- If causality to the incremental window is uncertain but plausible from changed evidence, prefer keeping with explicit uncertainty over confidently classifying it as unrelated.
- When suppressing in incremental mode due to out-of-window scope, state that rationale explicitly.
