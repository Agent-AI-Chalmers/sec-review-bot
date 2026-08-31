# Repository Scope Delta

## Scope Boundaries

- Verify only the current repository case report and mitigation outcome; nearby independent issues are out of scope.
- Keep verification bounded to the provided repository-scope runtime context.

## Case Audit Rules

- Treat the retained case as the audit target, not as proof that the analyzer confirmed the right repository-local problem.
- Be skeptical of broad historical security narratives weakly tied to this case's concrete repository path.
- Prefer the narrowest repository-grounded explanation that matches the actual code and patch.
- Do not elevate nearby independent issues into this case's reviewed claim or patch coverage judgment.
- If the retained case leans on a broad or famous vulnerability story but evidence supports only a narrower repository-local defect, narrow the reviewed claim accordingly instead of preserving the broad framing.
