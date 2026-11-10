# Bounded Verifier Feedback Retry

Language: English | [中文](BOUNDED_VERIFIER_FEEDBACK_RETRY.zh.md)

## Summary

This page describes the bounded verifier-to-mitigator feedback retry model in the shared review workflow.

The base downstream path is:

- `analyzer -> mitigator -> verifier`

When verifier concludes that an attempted patch is materially weak, incomplete, or risky, the workflow may take one bounded recovery pass:

- `analyzer -> mitigator(pass1) -> verifier(pass1) -> mitigator(pass2) -> verifier(pass2)`

Feedback retries have **an explicit limit** to prevent mitigation and verification from repeating indefinitely. The current policy allows one additional retry.

## Why This Exists

`verifier` is not only a terminal audit stage. It is also the stage to identify:

- incomplete security coverage
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

- Analyzer conclusions do not prevent the subsequent mitigation and verification stages from running.
- Mitigator decides whether to change code based on evidence. It may leave code unchanged when no safe, justified repair is available.
- Verifier independently checks whether the problem exists within the review scope and whether Mitigator handled it appropriately, even when there is no patch.
- If Verifier finds a concrete, repairable problem, it can ask Mitigator to try once more. This retry prioritizes the problems identified by Verifier, uses the original analysis as context, and does not rerun Analyzer.

### Normal Path

- `analyzer -> mitigator -> verifier`

If the first verification result needs no further action, no feedback retry is scheduled; the workflow continues to result assembly and any delivery steps.

### Recovery Path

- `analyzer -> mitigator(pass1) -> verifier(pass1) -> mitigator(retry) -> verifier(retry)`

During retry, the mitigator uses the previous repair result and verifier feedback to generate a new patch from the original prepared workspace. It checks the problems raised by the verifier first, then uses code and execution evidence to decide whether and how to revise the patch. The retry addresses the original review task and reruns mitigation and verification without rerunning the analyzer; the existing analysis continues to define the review scope.

### Generalized Bounded Model

Architecturally, the workflow is modeled as:

- `analyzer -> mitigator -> verifier -> [feedback-guided mitigator -> verifier] * k`

where:

- `k` is the number of additional mitigation/verification retries
- the code constant `MAX_FEEDBACK_RETRY_ATTEMPTS` bounds `k`

<!-- doc-default: MAX_FEEDBACK_RETRY_ATTEMPTS; source=agents/src/sec_review_agents/review_stages/feedback_loop.py -->
The code constant `MAX_FEEDBACK_RETRY_ATTEMPTS` limits additional retries to `1`, so `k <= 1`. This is not a deployment setting. Changing the limit requires considering context growth, latency, and model cost, and rerunning focused agent-behavior probes.

## Next Step

Verifier output separates current-code coverage from the next workflow action:

- `coverage`: how fully current code resolves the scoped security claim actually checked (`target_claim`), with or without a patch. It may be `full` when the original problem is already fixed or the claim is disproved by evidence
- `regression`: the conclusion supported by regression, build, test, or behavior-preservation evidence: `passed`, `failed`, `not-run`, `not-applicable`, or `unresolved`
- `next_step`: what should happen after the verification judgment

`next_step` has three values:

- `none`: no further action is needed for this verifier outcome. For a completed Verifier assessment, this requires `coverage=full` and `regression` to be `passed`, `not-run`, or `not-applicable`.
- `retry-ai`: a concrete, in-scope security gap or confirmed regression is likely fixable by one bounded AI mitigation retry pass.
- `manual-review`: unresolved regression evidence is the remaining factor that determines the next action, or the remaining work needs human judgment, repository administrator action, credential rotation, deployment/configuration changes, history cleanup, cache/fork cleanup, or some other action outside a normal workspace patch.

`coverage` and `regression` are independent judgments. A patch may fully cover the security target while failing a supported behavior contract. That outcome is `coverage=full` with `regression=failed`, but it is not delivery-ready and must use `retry-ai` or `manual-review` rather than `none`.

When a separate, concrete security gap is still suitable for bounded repair, `retry-ai` may be used even if `regression=unresolved`. The unresolved regression must remain in `findings` and be reassessed after the retry. If the unresolved regression itself determines the next action, use `manual-review`. In particular, `coverage=full` with `regression=unresolved` requires `next_step=manual-review`.

`partial` does not automatically mean retry. A partial patch can either expose an actionable code gap that should be retried, or it can represent useful current-snapshot hardening with residual work that only a human or repository administrator can complete. Examples:

- SSRF bypass remains in the patched URL/IP validation logic -> `coverage=partial`, `next_step=retry-ai`
- a bounded security gap remains and regression evidence is also unresolved -> `coverage=partial`, `regression=unresolved`, `next_step=retry-ai`, with both concerns retained in `findings`
- security coverage is full but the patch breaks a supported API contract -> `coverage=full`, `regression=failed`, `next_step=retry-ai` or `manual-review`
- committed secret removed from the current tree but still present in git history -> `coverage=partial`, `next_step=manual-review`

A safe current codebase does not approve every supplied change. With no patch, sufficient evidence can support `coverage=full`. With unnecessary, unrelated, or unsafe changes, record concrete concerns in `findings` and require follow-up instead of approving delivery.

## Retry Trigger Policy

Retry is driven by `next_step=retry-ai`, not by `coverage` alone.

A first mitigation attempt does not need to produce changed files to be retry-eligible. If verifier identifies a concrete in-scope repair that the first attempt missed, a remaining or unresolved gap with actionable `findings` may use `next_step=retry-ai`. The workflow bounds that recovery in the same way as a retry after a partial patch.

Retry-eligible patch judgments are usually `partial` / `local-only` / `unresolved` / `misaligned`. Full security coverage can also be retry-eligible when `regression=failed`. Every retry-eligible outcome must carry `next_step=retry-ai`.

The more common retry pattern is:

- analyzer provides a partial or narrow framing
- mitigator follows that framing
- verifier concludes that the analyzer framing was incomplete and that the resulting patch is also `partial`, `local-only`, or `misaligned`

In this situation, verifier identifies the concerns to investigate first during retry. Its judgment still needs to be checked against current repository evidence.

When verifier chooses `next_step=retry-ai`, it should include concrete `findings[]` text so the retrying mitigator has actionable patch-correction feedback instead of a vague negative verdict.

The design intent is simple: retry only when verifier has produced actionable patch-correction feedback. The mechanism is not meant to reopen every unsuccessful review.

## Retry Context Model

### Retrying Mitigator

The retrying mitigator should be framed as a bounded revision pass that receives:

- a brief previous mitigation summary, including overview and changed files
- the latest verifier result summary
- a compact history projection of earlier verifier feedback

Its operating rules are:

- treat the verifier report as the primary corrective signal
- investigate the verifier's blocking concerns first; current code and execution evidence determine whether and how to revise the patch
- preserve valid analyzer findings unless verifier-identified blockers or current code evidence require a correction
- fix confirmed problems; when rejecting a verifier concern, cite code or execution evidence that directly addresses it
- do not change the patch merely because analyzer and verifier disagree; a suggested patch shape is not mandatory, and supported concerns should be addressed without weakening the security fix to satisfy an unsafe legacy expectation
- leave unresolved concerns visible for the retrying verifier to assess; when unresolved evidence or required human judgment determines the next action, the verifier should use `manual-review`
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
