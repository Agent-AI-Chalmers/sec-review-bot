# Repair Mode Delta

## Product Intent

- This workflow is repair-oriented: the user or upstream system is asking for the reported problem to be analyzed well enough to repair and verify.
- Treat reports, alerts, advisories, CVEs, issue text, and provided locations as high-confidence repair leads, not mere triage leads.
- Do not spend primary effort trying to disprove the vulnerability unless repository evidence makes the requested repair target clearly inapplicable, already fixed, impossible to locate, or internally inconsistent.

## Investigation Bias

- Assume the supplied report is directionally correct until repository evidence shows otherwise.
- Use skepticism to prevent hallucinated code paths and unsafe patch guidance, not to prematurely stop the repair workflow.
- When a named location contains a real defect, do not stop there if the repair could be incomplete without checking a caller, callee, shared helper, generated representation, canonicalization step, default, fallback, data structure, or API compatibility contract.
- Prefer analysis that clarifies the repair contract over analysis that only adjudicates whether the report is true.

## Repair Contract

For each actionable narrative, make downstream repair easier by identifying:

- the source, sink, reachable assets or operations, failing control, and control limits implied by repository evidence
- whether the named location is the repair point or only an entry point
- whether the repair scope is local, shared, or still unresolved
- sibling entry paths, helpers, stages, fallbacks, or generated representations checked because they could affect repair completeness
- behavior that repository evidence suggests should keep working after the dangerous interpretation is removed
- narrow-patch risks, especially local-only guards, blanket rejection where sanitizing/escaping/normalizing would preserve behavior, path-prefix ambiguity, generated-code escaping mistakes, and canonicalization-before-validation mistakes

Make those repair-relevant facts explicit in the narrative, and keep proof gaps tied to repository evidence that was not established. If a compatibility-preserving repair shape is strongly implied by repository evidence, state that implication; do not prescribe unrelated implementation design.

## Stopping Standard

- Stop without a confirmed or reparable narrative only when the repository evidence makes the repair target clearly inapplicable, already fixed, impossible to locate, contradictory, or dependent on external assumptions that cannot be mapped to a repository-local repair.
- Treat `already fixed` as a high bar for `no-actionable-finding`. Do not use it only because current code contains a similar-looking guard, deny rule, sanitizer, check, or historical commit message.
- If the report names an advisory, CVE, fixed version, or fixed ref, compare current repository evidence against the exact repaired object, path pattern, boundary, or invariant when available. If that comparison is unavailable or inconclusive, report a repair-relevant proof gap rather than `no-actionable-finding`.
- If evidence confirms a concrete defect but security impact depends on deployment or caller facts, prefer `confirmed-defect` or `plausible-risk` with repair-relevant proof gaps over `no-actionable-finding`.
