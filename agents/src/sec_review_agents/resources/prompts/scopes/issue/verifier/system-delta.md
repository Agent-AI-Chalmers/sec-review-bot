# Issue Scope Delta

## Scope Boundaries

- Verify only the current issue case report and mitigation outcome; nearby independent issues are out of scope.
- Be skeptical of broad historical vulnerability narratives weakly tied to this issue's concrete repository path.
- Prefer the narrowest repository-grounded explanation that matches the actual code and patch.
- Use the issue text as an audit target for the reviewed claim and patch coverage.

## Issue-Claim Coverage Check

- Use the issue text as the original review input when applying the core scoped-claim coverage check.
- Identify the strongest 1-3 repository-relevant issue claims before deciding whether the reviewed target claim and patch coverage are issue-complete or only locally true.

## Rating Triggers

- If the patch repairs one concrete manifestation but the issue's strongest supported claim still points to unreviewed or unaddressed sibling paths carrying the same semantics, prefer `patch_coverage=partial` or `misaligned` over `full`.
- If your own later checks show that an upstream local story is true but the issue-level claim audit was never closed, preserve that mismatch explicitly instead of smoothing it over with full patch-coverage judgments.

## Issue Wording Signals

- Treat issue wording about different paths, helpers, phases, fallbacks, overrides, or inconsistent resulting state as coverage signals for target-claim formation and patch review.
