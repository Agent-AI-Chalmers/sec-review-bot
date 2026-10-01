# Narrative-First Review

Language: English | [中文](NARRATIVE_FIRST_REVIEW.zh.md)

Analyzer output is not a casual list of findings. It is organized around narratives. A narrative here is not vague speculation; it is a reviewable analysis direction with its own evidence and verdict. It can explain a confirmed issue, a plausible risk, an inconclusive path, or a direction reviewed as no-actionable-finding.

The purpose is to avoid an agent reading code, accumulating scattered observations, and leaving only a blurry impression. Instead, the system expects the agent to converge on a comparable set of explanations with clear priority. The basic output shape is:

- a set of narratives, each with an integer `priority`, where `1` is highest
- a small number of materially competing alternatives when needed, ordered through `priority`
- overall verdict, with `overview` carrying the reviewer-facing summary

This model has several constraints:

- If narratives are returned, each one must have a unique `priority`.
- `confirmed-vulnerability` and `confirmed-defect` must be consistent with the overall verdict.
- When a narrative has `verdict=confirmed-vulnerability`, it must land on concrete locations, `flow_review.source_facts`, and `flow_review.sink_facts`, not only abstract judgment.
- A no-actionable narrative should state the reviewed direction, the repository evidence that rejects an actionable concern, and any material proof gaps.
- `support_review.proof_gaps` records what evidence is still missing for a narrative.

For readers, the most important distinction is that the system does not first ask "is there a checklist vulnerability type here?" It first asks "which review directions are worth carrying forward, and what verdict does the evidence support for each one?" Vulnerability type, CWE, and verdict expand outward from this narrative-first structure, rather than choosing a label first and then assembling evidence around it.

This structure does not only serve analyzer output. Later stages consume it as a shared work object. The mitigator does not apply equal effort to an entire report; it prioritizes high-priority narratives whose verdict is `confirmed-vulnerability` or `confirmed-defect` when deciding whether to repair, where to repair, and where the smallest repair boundary should be. The verifier also does not redo a free-form analysis by default; it independently reviews the analyzer report, including narratives, priority, and verdict, together with the mitigation result. In other words, narrative-first is not only an output format. It is the shared work object across analyzer, mitigator, and verifier.

## A Real Example With Two Narratives

A review of a PR that changed how review results are published to GitHub ended with `no-actionable-finding`, while the analyzer retained two narratives. The PR used PostgreSQL to record publication progress so work could continue after process exits, timeout takeovers, or retries. The two narratives were neither two vulnerabilities nor competing explanations of the same issue. They were two independent review directions supporting the same overall verdict:

| Priority | Review direction | Main question | Representative boundaries |
| --- | --- | --- | --- |
| 1 | Input reaching dangerous sinks | Can Runner- or repository-influenced data cause SQL injection, path escape, branch injection, or Markdown breakout? | Parameterized SQL, branch-segment normalization, sensitive-path policy, Markdown code fences |
| 2 | Concurrency and remote side effects | During timeout, takeover, and retry, what state can a stale worker commit and how are remote GitHub operations recovered? | Claim tokens, heartbeats, publication steps, markers, and stable branch identity |

Their relationship can be represented as:

```text
overall verdict: no-actionable-finding
  ├─ narrative 1: input-to-sink controls expose no confirmed attack path
  └─ narrative 2: local state commits are fenced and remote retries have recoverable identities
```

Keeping them separate is useful because they depend on different evidence and can change verdict independently. Parameterized SQL does not establish safe concurrent publication, and a claim token does not establish safe file paths. Combining both directions into one narrative would mix their sources, sinks, controls, and proof gaps.

> The example also shows that multiple no-actionable narratives must still describe control limits precisely. Database fencing prevents a stale owner from committing local state, but it cannot revoke a GitHub request that was already sent. Heartbeats, marker reconciliation, and stable remote identities reduce and coordinate duplicate-side-effect risk; they do not provide remote atomic exactly-once execution. The defensible second narrative is therefore that local commits are fenced and remote retries use recoverable identities, not that duplicate GitHub side effects are impossible.
