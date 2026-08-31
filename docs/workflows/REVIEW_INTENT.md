# Review Intent

Language: English | [中文](REVIEW_INTENT.zh.md)

`review_intent` records what the caller wants this run to optimize for.

It has two fields:

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

Use it when the caller has not explicitly asked for repair, or when the supplied claim may be unsupported, overstated, already fixed, or not confirmable and repairable in the current repository.

Default behavior:

- Treat report, alert, issue text, PR description, case statement, and provided locations as claims to verify.
- Stay skeptical of broad historical, CVE-family, scanner, and issue narratives, especially when weakly tied to current repository evidence.
- When repository evidence does not support the original claim, allow narrowing, downgrading, or rejection.
- `plausible-risk` and `no-actionable-finding` are valid endpoints, not failures.
- Do not keep expanding without bounds to avoid a conservative verdict.
- Do not manufacture a patch just because a report exists.

### `repair`

Use it when the user or upstream system has already expressed repair intent.

Default behavior:

- Treat report, issue, advisory, CVE, alert, and provided locations as high-confidence repair leads.
- Do not spend the main effort disproving the vulnerability unless repository evidence shows the target is clearly inapplicable, already fixed, unlocatable, or internally contradictory.
- Treat cited locations as starting points, not the full repair boundary.
- Expand scope enough to decide whether the repair is local, shared, or unresolved.
- Identify compatibility constraints and narrow-patch risks for downstream repair.
- When repository evidence shows existing behavior should continue to work safely, prefer a compatibility-preserving interpretation.

`repair` does not allow hallucinated findings and is not blind obedience to reports. It still requires repository evidence. The difference is the default direction: advance toward the correct repair instead of re-arguing whether the user should have asked for repair.

## Repair Mode

`repair_mode` constrains repair output:

- `test-changes-allowed`: the final patch may contain legitimate supporting test changes.
- `no-test-changes`: the agent is instructed not to include test changes in the final patch; tests may only be used as temporary validation work.

`repair_mode` does not decide whether the input claim should be trusted. It only constrains the repair stage once repair is reached.

This is a prompt-level repair constraint, not mechanical enforcement. The runner does not classify repository files as tests or reject file changes based on path heuristics.

## Workflow Mapping

- `issue-review` accepts `objective = "audit"` and `objective = "repair"`.
- `pull-request-review` currently requires `objective = "audit"`.
- `repository-review` currently requires `objective = "audit"`.
- All workflows may receive `repair_mode`; mitigators use it as an agent-facing repair-stage patch boundary.

For issue review:

- automatic issue trigger: `review_intent.objective = "audit"`, because no human has explicitly decided "please fix this" yet.
- manual issue audit: `@<app-slug> review audit`.
- manual issue repair: `@<app-slug> review repair`, corresponding to `review_intent.objective = "repair"` and `review_intent.repair_mode = "test-changes-allowed"`.
- manual issue repair where the final patch must not contain test changes: `@<app-slug> review repair no-test-changes`, corresponding to `review_intent.objective = "repair"` and `review_intent.repair_mode = "no-test-changes"`.
