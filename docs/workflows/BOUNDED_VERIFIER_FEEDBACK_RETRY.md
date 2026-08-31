# Bounded Verifier Feedback Retry

Language: English | [中文](BOUNDED_VERIFIER_FEEDBACK_RETRY.zh.md)

## Summary

This page describes the bounded verifier-to-mitigator feedback retry model in the shared review workflow.

The base downstream path is:

- `analyzer -> mitigator -> verifier`

When verifier concludes that an attempted patch is materially weak, incomplete, or risky, the workflow may take one bounded recovery pass:

- `analyzer -> mitigator(pass1) -> verifier(pass1) -> mitigator(pass2) -> verifier(pass2)`

This is intentionally **not** an open-ended loop. The architecture supports a retry budget, but the operating policy remains single-retry.

## Why This Exists

`verifier` is not only a terminal audit stage. It is also the stage to identify:

- incomplete patch coverage
- ineffective remediation
- unsafe fixes
- overstated analyzer claims that should no longer drive patch scope

Without a bounded retry path, that judgment is descriptive but not corrective. The feedback retry mechanism makes verifier operationally useful while preserving deterministic stop conditions.

---

There is also a structural reason for this mechanism. A single agent can often verify and revise its own patch inside one continuous run. A multi-stage workflow cannot. Once analysis, mitigation, and verification are split into separate stages, verifier output remains purely downstream unless the system explicitly feeds it back into mitigation. Without that feedback path, the multi-stage design gives up a basic self-correction loop.

---

Verifier-led retry is weaker than a failed PoC, a failed test, or another directly reproducible failure signal. Those signals are stronger because they come from running the code, not from model judgment.

In practice, though, many security repair tasks do not come with runnable PoCs, stable repro harnesses, or tests that directly validate the fix. When those conditions exist, the task is unusually well prepared. So verifier-led retry is less authoritative than executable validation, but it applies to the more common case and serves as the default fallback quality gate.

## Core Workflow

### Normal Path

- `analyzer -> mitigator -> verifier`

If the first verifier result is acceptable, the workflow ends.

### Recovery Path

- `analyzer -> mitigator(pass1) -> verifier(pass1) -> mitigator(retry) -> verifier(retry)`

The retry is a bounded revision pass over the same scoped task. The retrying mitigator uses the previous attempt and verifier feedback as context, but starts from the prepared baseline workspace again rather than stacking edits on top of the previous patch. In particular, the retry path stays on the mitigation-verification path rather than reopening analyzer. Analyzer remains the baseline scope artifact, while verifier objections constrain the retrying mitigation pass.

### Generalized Bounded Model

Architecturally, the workflow is modeled as:

- `analyzer -> mitigator -> verifier -> [feedback-guided mitigator -> verifier] * k`

where:

- `k <= maxFeedbackRetries`
- operating policy uses `maxFeedbackRetries = 1`

The important property is the budget, not the exact number. The design leaves room for modest future experiments without turning the workflow into an unbounded conversational loop.

## Resolution Next Step

Verifier output separates patch coverage from the next workflow action:

- `patch_coverage`: how well the patch covers the reviewed target claim
- `resolution_next_step`: what should happen after the verification judgment

`resolution_next_step` has three values:

- `none`: no further action is needed for this verifier outcome. This is the normal value for `patch_coverage=full`.
- `retry-ai`: the remaining gap is concrete, in scope, and likely fixable by one bounded AI mitigation retry pass.
- `manual-review`: the remaining work needs human judgment, repository administrator action, credential rotation, deployment/configuration changes, history cleanup, cache/fork cleanup, or some other action outside a normal workspace patch.

`partial` does not automatically mean retry. A partial patch can either expose an actionable code gap that should be retried, or it can represent useful current-snapshot hardening with residual work that only a human or repository administrator can complete.

Examples:

- SSRF bypass remains in the patched URL/IP validation logic -> `patch_coverage=partial`, `resolution_next_step=retry-ai`
- committed secret removed from the current tree but still present in git history -> `patch_coverage=partial`, `resolution_next_step=manual-review`

## Retry Trigger Policy

Retry is driven by `resolution_next_step=retry-ai`, not by `patch_coverage` alone.

Retry-eligible patch judgments are usually `partial` / `local-only` / `unresolved` / `misaligned`, but they must also carry `resolution_next_step=retry-ai`.

The more common retry pattern is:

- analyzer provides a partial or narrow framing
- mitigator follows that framing
- verifier concludes that the analyzer framing was incomplete and that the resulting patch is also `partial`, `local-only`, or `misaligned`

That is the case where retry is useful. In that situation, verifier is not only rejecting the patch. It is also taking over the effective framing for the retry pass.

When verifier chooses `resolution_next_step=retry-ai`, it should include concrete `patch_findings[]` text so the retrying mitigator has actionable patch-correction feedback instead of a vague negative verdict.

The design intent is simple: retry only when verifier has produced actionable patch-correction feedback. The mechanism is not meant to reopen every unsuccessful review.

## Retry Context Model

### Retrying Mitigator

The retrying mitigator should be framed as a bounded revision pass that receives:

- a brief previous mitigation summary, including status, overview, and changed files
- the latest verifier result summary
- a compact history projection of earlier verifier feedback

Its operating rules are:

- treat the verifier report as the primary corrective signal
- once retry begins, treat verifier as the effective framing authority for the retry pass
- preserve valid analyzer findings unless verifier explicitly challenges them
- when analyzer claims conflict with verifier concerns, prefer the verifier's safer interpretation
- use the previous attempt and verifier feedback as revision context, but generate the retry patch from the prepared baseline workspace rather than stacking edits on top of the previous patch
- use the previous mitigation summary only to understand what the last attempt did, not as the source of truth for the retry patch
- stay within the original issue, pull request, or repository-case scope
- avoid unrelated cleanup or broad refactors

### Retrying Verifier

The retrying verifier is feedback-aware, but its independence is preserved.

It should receive:

- the previous verifier result
- the previous verifier patch findings
- the new mitigation summary
- the new workspace patch
- a history projection of earlier verifier feedback
- analyzer summary only when needed for continuity

That context exists to help verifier judge whether earlier patch concerns are now:

- resolved
- still present
- superseded

The retrying verifier is not meant to redo a full analyzer audit by default. Prior verifier judgments are continuity context, not binding authority. The new patch and current repository evidence remain the basis for the new verification decision.

## Context And History Policy

The workflow may retain complete retry history locally, but the agent should receive only a **history projection** suited to its current task.

The workflow should retain:

- the initial mitigation and verifier outcomes
- later retry attempts
- retry trigger reasons

This full history is valuable for:

- auditability
- comparison between initial and revised outcomes
- downstream inspection

The history projection for retrying mitigator should center on:

- original analyzer scope
- latest verifier feedback
- what the previous mitigation attempted and which files it changed
- earlier verifier patch findings as a compact history snapshot

The history projection for retrying verifier should center on:

- current patch and repository evidence
- the previous verifier patch findings
- enough continuity to decide whether the new patch resolved, preserved, or superseded those findings

Older verifier history should be summarized structurally rather than replayed blindly as raw full-text reports.

## Design Boundary

This architecture is intentionally optimized for **small retry budgets**, not arbitrarily large `N`.

If the retry budget grows, the expected costs also grow:

- more context carry-forward
- longer prompts
- higher latency
- higher cost

That is acceptable for bounded experimentation, but it is not a goal of this design to make large retry counts cheap or structurally invisible.
