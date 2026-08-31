# Integration Contract v4

Language: English | [中文](CONTRACT_V4.zh.md)

This document defines the workflow `input` submitted through the runner HTTP API and the `result` returned after a run completes. For the HTTP transport itself, see [RUNNER_HTTP_API.md](RUNNER_HTTP_API.md).

Representative JSON fixtures live under [`fixtures/v4`](fixtures/v4). Python and TypeScript contract tests both read these fixtures.

The v4 public result exposes final results for each workflow instead of internal stage execution details:

- issue review and pull request review return one `ReviewRecord`.
- repository review returns a scan summary, case-level `ReviewRecord` projections, and repository-only delivery results.

## 1. Workflow Inputs

This section defines the workflow `input` object inside the HTTP create-run request body. HTTP envelope fields such as `run_id` and `runtime` are defined in [RUNNER_HTTP_API.md](RUNNER_HTTP_API.md).

Every workflow input includes:

- `contract_version: "v4"`
- `input_bundle_uri`
- `review_intent`

### Input Bundle Boundary

`input_bundle_uri` points to the caller-provided input bundle root. Current production integration requires that bundle to be readable by the runner worker.

This coupling is deliberate: GitHub App or a local materializer turns GitHub context into local workspace, history, and incremental-window materials; the runner only consumes those materials and executes the workflow.

The caller owns the input bundle. The runner/stages own runtime state such as `artifact_paths`, stage artifact roots, writable stage workspaces, retry state, and delivery assignments.

The bundle root must contain `manifest.json`. The manifest declares paths to materials inside the bundle; the runner parses it into internal `bundle_paths` for workflow/backend use. Callers must not provide `bundle_paths` directly.

Repository scan target:

```ts
interface RepositoryScanTarget {
  target_branch: string
  default_branch: string
  event_type: 'manual' | 'scheduled'
  scan_mode: 'full' | 'incremental'
  base_sha: string | null
  head_sha: string
  commit_shas: string[]
}
```

- `target_branch` is the branch/ref label selected by the caller.
- `base_sha` / `head_sha` / `commit_shas` describe the scan delta window, corresponding semantically to PR workflow base/head/commit context.
  - for full scans, `base_sha` is `null` and `commit_shas` is empty;
  - for incremental scans, `base_sha..head_sha` defines the window, and `commit_shas` describes the commits in that window.

Repository scan scope:

```ts
interface RepositoryScanScope {
  max_file_bytes: number
  paths_ignore: string[]
  incremental_changed_files: Array<{
    path: string
    status: string
    previous_path: string | null
  }>
}
```

Review intent:

```ts
interface ReviewIntent {
  objective: 'audit' | 'repair'
  repair_mode?: 'test-changes-allowed' | 'no-test-changes'
}
```

Issue workflows use:

```ts
interface IssueReviewInput {
  contract_version: 'v4'
  input_bundle_uri: string
  review_intent: ReviewIntent
  issue: Record<string, unknown>
}
```

Pull request workflows use:

```ts
interface PullRequestReviewInput {
  contract_version: 'v4'
  input_bundle_uri: string
  review_intent: ReviewIntent
  pr: Record<string, unknown>
}
```

Repository workflows use:

```ts
interface RepositoryReviewInput {
  contract_version: 'v4'
  input_bundle_uri: string
  review_intent: ReviewIntent
  scan_target: RepositoryScanTarget
  scan_scope: RepositoryScanScope
}
```

The runner validates input at the process boundary. All workflows require these common fields:

- `contract_version`
- `input_bundle_uri`
- `review_intent`

`review_intent.objective` declares the review objective:

- `audit`
- `repair` (`issue-review` only; pull request and repository workflows currently require `audit`)

`review_intent.repair_mode` is optional and constrains later repair stages. If omitted, it defaults to `test-changes-allowed`:

- `test-changes-allowed`
- `no-test-changes`

`repair_mode` is a prompt constraint for the agent. It is not mechanical enforcement; the runner does not classify repository paths as tests or reject file changes based on path heuristics.

Each workflow also requires:

| Workflow | Required fields |
| --- | --- |
| `issue-review` | `issue` |
| `pull-request-review` | `pr` |
| `repository-review` | `scan_target`; `scan_scope` |

`repository-review` uses `scan_target` and `scan_scope` as its explicit cost and coverage boundary:

| Object | Required fields |
| --- | --- |
| `scan_target` | `target_branch`; `default_branch`; `event_type`; `scan_mode`; `base_sha`; `head_sha`; `commit_shas` |
| `scan_scope` | `max_file_bytes`; `paths_ignore`; `incremental_changed_files` |

The `scan_mode` selects the window shape:

| Mode | Required / shape |
| --- | --- |
| `full` | `scan_scope.incremental_changed_files: []`; `base_sha: null`; `commit_shas: []` |
| `incremental` | input bundle manifest includes `incremental_window.path`; `base_sha` is a non-empty string distinct from `head_sha`; `commit_shas` is non-empty; `scan_scope.incremental_changed_files` declares the changed-file scope and may be empty when the explicit window has no scannable changed files |

Repository scan scope controls cost and coverage. The runner must not guess it:

- Missing or unknown `scan_mode` does not default to `full`. A full scan can scan the whole repository, so cost and latency must be explicit caller decisions.
- `incremental` also cannot be inferred from missing configuration. The caller must provide an explicit incremental window and `scan_scope.incremental_changed_files`.
- `scan_scope` is a required safety valve, not an optional optimization; it declares file size limits, ignored paths, and incremental changed-file scope.

## 2. Workflow Results

### ReviewRecord

`ReviewRecord` is the shared review result shape used by issue, pull request, and repository workflows:

```ts
interface ReviewRecord {
  analysis: {
    verdict: 'no-actionable-finding' | 'inconclusive' | 'plausible-risk' | 'confirmed-defect' | 'confirmed-vulnerability' | null
    overview: string | null
    narratives: Array<Record<string, unknown>>
  }
  mitigation: {
    overview: string | null
    changed_files: string[]
    file_changes: Array<
      | {
          path: string
          status: 'upsert'
          content: string
          content_encoding: 'utf-8' | 'base64'
          mode?: '100644' | '100755'
        }
      | {
          path: string
          status: 'deleted'
        }
    >
    patch_diff: string | null
  }
  verification: {
    overview: string | null
    review_target_claim: string | null
    validation_level: 'static' | 'logic-simulated' | 'runtime-partial' | 'runtime-endpoint' | null
    patch_coverage: 'full' | 'partial' | 'local-only' | 'unresolved' | 'misaligned' | 'no-patch' | 'not-applicable' | null
    regression_status: 'passed' | 'failed' | 'not-run' | 'not-applicable' | 'unresolved' | null
    resolution_next_step: 'none' | 'retry-ai' | 'manual-review' | null
    patch_findings: string[]
    verification_findings: string[]
    residual_risks: string[]
  }
  cvss: {
    outcome: 'scored' | 'not-scored' | 'skipped' | null
    base_score: number | null
    severity: string | null
    vector: string | null
    overview: string | null
    not_scored_reason: string | null
  } | null
}
```

Issue and PR presentation use `ReviewRecord` directly. Repository case presentation uses case IDs plus the analysis, mitigation, verification, and CVSS projections from `ReviewRecord`.

`ReviewRecord` is a workflow result projection. Runtime diagnostics belong to observability and artifact debugging, not `ReviewRecord`.

Runtime exceptions are not part of `ReviewRecord`. If analyzer / mitigator / verifier / discovery / delivery synthesis fails at runtime, the workflow run should fail and the runner HTTP API should return a structured runner error. Do not publish stage-level `status="error"`, `unavailable`, or other compatibility error projections in the public result.

> *CVSS is an optional score shown in the report, not the pass/fail signal for the review. If repository CVSS scoring fails after the case review itself succeeds, publish `ReviewRecord.cvss` as `null` and keep the scoring failure details in diagnostics and artifacts.*

`verification.patch_coverage="full"` requires the verifier to report full coverage for the patch target. Partial coverage remains unresolved and must not enter repository delivery / draft PR publication.

`verification.regression_status` reports whether focused regression, behavior-preservation, build, or test evidence supports the patched workspace. It is separate from security-target coverage: a patch can fully cover the reviewed security claim while tests were not run or while regression readiness remains unresolved.

`verification.resolution_next_step` describes the next action after verifier judgment: `none` means no further action is needed; `retry-ai` means there is a concrete patch gap that bounded AI mitigation can continue fixing; `manual-review` means remaining work requires human review, administrator action, credential rotation, history cleanup, deployment/configuration changes, or another capability outside normal workspace patching.

### Issue Review Result

Workflow: `issue-review`

Input keeps the existing issue input contract and expresses review intent through `review_intent`. This is the workflow where `review_intent.objective = "repair"` changes analyzer stance and the mitigation gate.

Core result shape:

```ts
interface IssueWorkflowResult {
  contract_version: 'v4'
  review_record: ReviewRecord
}
```

`issue-review-two-stage` and `issue-review-single-agent` are local evaluation / ablation paths. They may be started by local CLI as local-only Temporal workflows, but they are not part of the standard public runner contract.

Callers must render issue comments, decide whether a patch exists, and create draft PRs from `review_record`. When publishing a draft PR, `review_record.mitigation.file_changes` is the authoritative source for final file contents.

### Pull Request Review Result

Workflow: `pull-request-review`

Core result shape:

```ts
interface PullRequestWorkflowResult {
  contract_version: 'v4'
  review_record: ReviewRecord
}
```

Callers must render PR comments and decide whether to publish suggestions from `review_record`.

### Repository Review Result

Workflow: `repository-review`

Repository review is composed of `scan -> case review -> delivery`:

- `scan_summary` is the public scan-stage summary; full discovery / triage outputs are kept in artifacts.
- `case_results[].review_record` is the case-level review output.
- `deliveries[]` contains repository delivery results and publishable artifacts produced by delivery execution.

Core result shape:

```ts
interface RepositoryReviewWorkflowResult {
  contract_version: 'v4'
  scan_summary: ScanSummary
  case_results: RepositoryCaseResult[]
  deliveries: RepositoryDelivery[]
}
```

`ScanSummary`:

```ts
interface ScanSummary {
  scannable_file_count: number
  scanned_file_count: number
  skipped_file_count: number
  candidate_count: number
  case_count: number
  suppressed_candidate_count: number
}
```

`RepositoryCaseResult`:

```ts
interface RepositoryCaseResult {
  case_id: string
  disposition: 'keep' | 'blocked' | string
  reason: string | null
  review_record: ReviewRecord
}
```

`case_results[]` expresses case-level public results through `case_id`, `disposition`, `reason`, and `review_record`.

The GitHub summary renderer can render confirmed cases that did not reach the delivery gate as blocked case cards from `case_results[]`.

### Repository Deliveries

`RepositoryReviewWorkflowResult.deliveries[]` contains `RepositoryDelivery` items.

```ts
interface RepositoryDelivery {
  delivery_id: string
  case_ids: string[]
  file_changes: Array<
    | {
        path: string
        status: 'upsert'
        content: string
        content_encoding: 'utf-8' | 'base64'
        mode?: '100644' | '100755'
      }
    | {
        path: string
        status: 'deleted'
      }
  >
}
```

`RepositoryDelivery` is the authoritative input for callers publishing repository delivery draft PRs. Each delivery must carry final `file_changes`; display file paths are derived from `file_changes[].path`. `case_ids` links back to case-level review details in top-level `case_results[]`.

## 3. Compatibility

The following changes are breaking changes:

- Removing or renaming a workflow.
- Removing `review_record` or changing the meaning of its core fields.
- Removing `deliveries[]` or changing the meaning of repository delivery result core fields.

The following changes are not breaking changes:

- Adding optional fields.
- Changing internal Python module paths or stage implementation.
