# Review Intent

Language: English | [中文](REVIEW_INTENT.zh.md)

`review_intent` records the review objective a *caller* asks the runner to serve, plus an optional repair-stage constraint.

The caller and the end user are different roles, and the distinction matters here:

- The **caller** is whatever program invokes the runner and sets `review_intent`: the GitHub integration, the PatchEval harness, or a local CLI run.
- The **end user** interacts with that caller — for example, commenting `@<app-slug> review` on a GitHub issue. An end user never chooses the `objective`; on GitHub they can still set `repair_mode`, by adding `no-test-changes` to the comment.

How a caller chooses the objective is its own product decision, not something `review_intent` decides. The GitHub integration always sends `audit`, because the input it forwards (an issue or pull request someone wrote) is an unverified claim. The PatchEval harness may send `repair`, because its input is a known CVE. The contract accepts both; each caller picks one.

## Fields

```json
{
  "review_intent": {
    "objective": "audit",
    "repair_mode": "no-test-changes"
  }
}
```

- `objective`: the review objective, either `audit` or `repair`.
- `repair_mode`: an optional repair-stage constraint, either `test-changes-allowed` or `no-test-changes`. If omitted, the runner uses `test-changes-allowed`.

These fields are related, but they are not the same decision. `objective` changes how the workflow treats the input claim. `repair_mode` constrains the final patch if repair runs.

## Objective

### `audit`

The caller has not treated the input claim as already confirmed, so the workflow verifies it first. Use it when the claim may be unsupported, overstated, already fixed, or not confirmable and repairable in the current repository.

Default behavior:

- Treat report, alert, issue text, PR description, case statement, and provided locations as claims to verify.
- Stay skeptical of broad historical, CVE-family, scanner, and issue narratives, especially when weakly tied to current repository evidence.
- When repository evidence does not support the original claim, allow narrowing, downgrading, or rejection.
- `plausible-risk` and `no-actionable-finding` are valid endpoints, not failures.
- Do not keep expanding without bounds to avoid a conservative verdict.
- Do not manufacture a patch just because a report exists.

### `repair`

The caller has established that the input is a confirmed repair target — for example the PatchEval harness, whose input is a known CVE. Only a caller that holds a trusted input should send it.

Default behavior:

- Treat report, issue, advisory, CVE, alert, and provided locations as high-confidence repair leads.
- Do not spend the main effort disproving the vulnerability unless repository evidence shows the target is clearly inapplicable, already fixed, unlocatable, or internally contradictory.
- Treat cited locations as starting points, not the full repair boundary.
- Expand scope enough to decide whether the repair is local, shared, or unresolved.
- Identify compatibility constraints and narrow-patch risks for downstream repair.
- When repository evidence shows existing behavior should continue to work safely, prefer a compatibility-preserving interpretation.

`repair` does not allow hallucinated findings and is not blind obedience to reports. It still requires repository evidence. The difference is the default direction: advance toward the correct repair instead of re-arguing whether a repair was warranted.

## Repair Mode

`repair_mode` constrains repair output:

- `test-changes-allowed`: the final patch may contain legitimate supporting test changes.
- `no-test-changes`: the agent is instructed not to include test changes in the final patch; tests may only be used as temporary validation work.

`repair_mode` does not decide whether the input claim should be trusted. It only constrains the repair stage once repair is reached.

This is a prompt-level repair constraint, not mechanical enforcement. The runner does not classify repository files as tests or reject file changes based on path heuristics.
