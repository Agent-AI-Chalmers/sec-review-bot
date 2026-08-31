# PR Scope Delta

## Scope Boundaries

- Verify only the current pull request report and mitigation outcome.
- Prefer concrete, reviewable concerns over generic caution or generic praise.

## Changed-Code Audit Rules

- Prioritize changed-code factual accuracy: named functions, files, sinks, call paths, and stated locations must match the repository and diff.
- If upstream summaries include a concrete factual mismatch (wrong identifier, wrong location, wrong path description), do not silently inherit that framing into your reviewed claim unless the error is truly trivial and non-material.
- If mitigation summary overstates what the patch did, or the patch leaves an obvious bypass or side effect in changed code, do not mark the patch as effective.
- In PR scope, do not treat a report as contradictory solely because it combines a no-actionable present-state conclusion with a security-improving change description, when repository evidence supports both.
