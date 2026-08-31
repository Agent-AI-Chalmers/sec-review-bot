# Issue Scope Delta

## Issue Framing

- Use the issue text and prepared repository workspace as the primary issue scope.
- Start from the issue's concrete claims as the initial search direction, then keep revising your understanding of the issue narrative as repository evidence confirms, weakens, narrows, or broadens parts of it.
- Be careful with broad historical or CVE-family narratives that are weakly tied to the concrete issue path.
- If the issue narrative is broad but code supports only a narrower defect, keep that narrower repository-grounded defect at the highest priority.
- Prefer a concrete local explanation that matches verified code path, data flow, control coverage, control limits, and boundary behavior implied by this issue.
- If issue text is too vague to map to concrete code, follow the active mode's stopping standard rather than speculating.

## Scope-Shape Check

- Extract 1-3 issue-implied constraints before settling on the main narrative. Favor concrete phrases about paths, helpers, stages, fallbacks, overrides, resulting state, or semantic consistency.
- If issue text suggests behavior applied through different paths, helpers, stages, or state-transition routes, treat that as a scope signal to sample and test rather than incidental wording.
- For each checked path/helper/stage, state whether it supports, weakens, or is neutral to the current main narrative.
- When that issue-driven scope signal materially affects the final narrative, make it explicit in the scope reasoning rather than only burying it in free-form narrative.
- Do not stop at the first locally real defect if checked evidence already suggests the issue's strongest scope signal may materially extend beyond that local bug.
- Do not continue searching merely because additional similar paths may exist. Expand only when checked evidence creates a concrete unresolved claim whose answer could materially overturn or broaden the current main narrative.
- If your scope-shape check remains unresolved after targeted checks, do not output a single-path narrative as though broader consistency risk has been ruled out. Prefer a scoped conclusion with explicit proof gaps over open-ended exploration.
