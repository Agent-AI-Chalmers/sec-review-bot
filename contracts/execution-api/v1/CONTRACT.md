# Execution API v1 Payloads

Language: English | [中文](CONTRACT.zh.md)

This document defines the workflow `input` submitted through Execution API v1 and the `result` returned after a run completes. The HTTP operations and envelopes are defined by [the OpenAPI document](openapi.yaml) in this same API version.

Representative JSON fixtures live under [`fixtures`](fixtures). Python and TypeScript contract tests both read these fixtures.

The v1 public result exposes final results for each workflow instead of internal stage execution details:

- issue review and pull request review return one `ReviewRecord`.
- repository review returns a scan summary, case-level `ReviewRecord` projections, and repository-only delivery results.

## 1. Workflow Inputs

This section defines the workflow `input` object inside the HTTP create-run request body. HTTP envelope fields such as `run_id` and `runtime` are defined in [the Execution API OpenAPI document](openapi.yaml).

Every workflow input includes:

- `api_version: "v1"`
- `input_bundle`
- `review_intent`

### Input Bundle Boundary

`input_bundle` is an immutable artifact reference to a complete input bundle archive. The caller prepares and uploads the archive; the Execution Worker verifies it and materializes it into a local run-scoped directory before reading the manifest or executing a workflow.

The v1 Execution Worker accepts only these canonical input-bundle URI forms:

- `file:///absolute/path` or `file://localhost/absolute/path` for a local file;
- `s3://bucket/non-empty-key` for a durable S3 object.

Other `file:` spellings, including `file:/absolute/path`, are rejected. An S3 URI authority contains only the bucket name: user information and ports are rejected. Both forms reject whitespace, query strings, and fragments. Storage endpoint, region, and credentials are deployment configuration and never come from workflow input. Presigned HTTP URLs are not durable artifact references.

The caller owns the input bundle. The Execution Worker and its stages own runtime state such as `artifact_paths`, stage artifact roots, writable stage workspaces, retry state, and delivery assignments.

The `input_bundle` archive must conform to the [input-bundle artifact v1 profile](../../tar-zstd-artifact/profiles/input-bundle/v1/SPEC.md). The Execution Worker validates it and resolves its declared paths into internal `bundle_paths`; callers must not provide `bundle_paths` directly.

The `input_bundle` object shape and canonical URI syntax are defined by [`common.schema.json`](schemas/common.schema.json).

Repository scan target (`scan_target` in [`repository-review-input.schema.json`](schemas/repository-review-input.schema.json)):

- `target_branch` is the branch/ref label selected by the caller.
- `base_sha` / `head_sha` / `commit_shas` describe the scan delta window, corresponding semantically to PR workflow base/head/commit context.
  - for full scans, `base_sha` is `null` and `commit_shas` is empty;
  - for incremental scans, `base_sha..head_sha` defines the window, and `commit_shas` describes the commits in that window.

Repository scan scope (`scan_scope` in the same schema) declares `paths_ignore` and `incremental_changed_files`.

Each workflow input has its own schema:

| Workflow              | Schema                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `issue-review`        | [`issue-review-input.schema.json`](schemas/issue-review-input.schema.json)               |
| `pull-request-review` | [`pull-request-review-input.schema.json`](schemas/pull-request-review-input.schema.json) |
| `repository-review`   | [`repository-review-input.schema.json`](schemas/repository-review-input.schema.json)     |

Pull request inputs carry a `pr` subject describing the pull request as this run sees it. The schema cannot express how two of its fields relate:

- `base_sha` and `head_sha` identify the pull request itself and stay constant for the run.
- `review_window` states the range the run covers. On `synchronize` it normally covers newly pushed commits and is narrower than `base_sha..head_sha`; fallback conditions may instead select the full PR range. `review_window.reason` records why a run fell back to the full range.

The Execution API provider and Execution Worker both validate input at their process boundaries. All workflows require these common fields:

- `api_version`
- `input_bundle`
- `review_intent`

`review_intent.objective` declares the review objective:

- `audit`
- `repair` (`issue-review` only; pull request and repository workflows currently require `audit`)

`review_intent.test_changes` is optional and constrains the final mitigation patch. If omitted, it defaults to `allow`:

- `allow`: the final mitigation patch may contain reasonable test changes.
- `deny`: the final mitigation patch must not contain test changes; tests may only be used as temporary validation work.

`test_changes` is a prompt constraint for the agent. It is not mechanical enforcement; the Execution Worker does not classify repository paths as tests or reject file changes based on path heuristics.

`setup_declaration` is an optional string carrying the contents of `.sec-review/setup.yml` on the reviewed repository's default branch. For pull requests, use the base repository's default branch, not the fork or PR head. It is inline declaration text, not a path: callers fetch the file and pass its contents. Omission means no setup declaration steps run. The declaration is parsed strictly and executed inside the sandbox before the agent starts. The caller is responsible for trusted provenance; Execution Worker does not check the declaration against its repository source.

`repository-review` uses `scan_target` and `scan_scope` as its explicit cost and coverage boundary.

The `scan_mode` selects the window shape:

| Mode          | Required / shape                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `full`        | `scan_scope.incremental_changed_files: []`; `base_sha: null`; `commit_shas: []`                                                                                                                                                                                                                  |
| `incremental` | input bundle manifest includes `incremental_window.path`; `base_sha` is a non-empty string distinct from `head_sha`; `commit_shas` is non-empty; `scan_scope.incremental_changed_files` declares the changed-file scope and may be empty when the explicit window has no scannable changed files |

Repository scan scope controls cost and coverage. The Execution Worker must not guess it:

- Missing or unknown `scan_mode` does not default to `full`. A full scan can scan the whole repository, so cost and latency must be explicit caller decisions.
- `incremental` also cannot be inferred from missing configuration. The caller must provide an explicit incremental window and `scan_scope.incremental_changed_files`.
- `scan_scope` is a required safety valve, not an optional optimization; it declares ignored paths and incremental changed-file scope.

## 2. Workflow Results

### ReviewRecord

`ReviewRecord` is the shared review result shape used by issue, pull request, and repository workflows. Its field types and enum values are defined by [`review-record.schema.json`](schemas/review-record.schema.json).

Issue and PR presentation use `ReviewRecord` directly. Repository case presentation uses case IDs plus the analysis, mitigation, verification, and CVSS projections from `ReviewRecord`.

`ReviewRecord` is a workflow result projection. Runtime diagnostics belong to observability and artifact debugging, not `ReviewRecord`.

`ReviewRecord.mitigation.file_changes` is the authoritative patch state. Display paths are derived from `file_changes[].path`; there is no independent `changed_files` field. `patch_diff` is a cached review and location artifact that may be regenerated from the baseline tree and `file_changes`; it must not be treated as another source of final file contents.

`file_changes` upserts use Git blob modes: `100644` (regular), `100755` (executable), or `120000` (symbolic link). An omitted mode means `100644`. For `120000`, decoded `content` contains the link target bytes, not the referenced file contents; consumers must not resolve the target when publishing. Targets may be relative, absolute, or dangling. The entry path still obeys repository-path validation. Deletions use `status: "deleted"` without a mode, including link deletions. Switching modes replaces the entry type. Producers and publishers must be upgraded together before emitting `120000`; older consumers may reject the new enum value. The worker’s textual `patch_diff` export requires UTF-8 diff bytes and rejects non-UTF-8 diffs explicitly; base64 support in `file_changes` alone does not remove that export limitation.

The Execution Worker produces this projection from internal stage output. Its `ReviewRecord` builder intentionally keeps only the public fields: unknown internal fields are discarded, malformed optional scalar values become `null`, and malformed list members are omitted. This degradation policy applies only while producing optional report detail. The completed public result must still validate against the full workflow result schema before it crosses the Execution API boundary.

`ReviewRecord` contains review results, not runtime exceptions. Exceptions are handled as follows:

- Unhandled exceptions in stages such as Discovery, Triage, Analyzer, Mitigator, Verifier, and delivery / patch synthesis fail the workflow run. Execution API returns a structured execution error.
- Patch synthesis failures caught by the delivery layer are recorded in delivery results.

> _CVSS is an optional score shown in the report, not the pass/fail signal for the review. If repository CVSS scoring fails after the case review itself succeeds, publish `ReviewRecord.cvss` as `null` and keep the scoring failure details in diagnostics and artifacts._

`verification.coverage` describes current-code safety for `target_claim`, independently of patch presence. `full` means repository evidence establishes that the target is resolved, already fixed, or not applicable to this code; `partial`, `local-only`, and `misaligned` describe remaining gaps, and `unresolved` means evidence is insufficient. With no changes, assess the baseline. Use `mitigation.file_changes` to determine whether a patch exists. Coverage alone does not approve delivery: a patch must exist, regression evidence must not block it, and `next_step` must be `none`. Report concerns about unnecessary or unrelated changes in findings and the next action even when current-code coverage is `full`.

`target_claim` identifies the scoped claim, `coverage` assesses current-code safety for that claim, `regression` reports regression checks, and `next_step` requests further action. `findings` records problems requiring follow-up; `evidence` records the checks and observations supporting the judgment. Producers and consumers must be upgraded together when this result shape changes. Existing artifacts remain historical records; renaming fields alone cannot establish a new assessment.

`verification.regression` reports whether focused regression, behavior-preservation, build, or test evidence supports the patched workspace. It is separate from security-target coverage: a patch can fully cover the reviewed security claim while tests were not run or while regression readiness remains unresolved.

`verification.next_step` describes the next action after verifier judgment: `none` means no further action is needed; `retry-ai` means there is a concrete patch gap that bounded AI mitigation can continue fixing; `manual-review` means remaining work requires human review, administrator action, credential rotation, history cleanup, deployment/configuration changes, or another capability outside normal workspace patching.

### Issue Review Result

Workflow: `issue-review`

Input keeps the existing issue input contract and expresses review intent through `review_intent`. This is the workflow where `review_intent.objective = "repair"` changes analyzer stance. Analyzer conclusions do not determine admission to mitigation or verification.

The result shape is defined by [`issue-review-result.schema.json`](schemas/issue-review-result.schema.json).

Callers must render issue comments, decide whether a patch exists, and create draft PRs from `review_record`. When publishing a draft PR, `review_record.mitigation.file_changes` is the authoritative source for final file contents.

### Pull Request Review Result

Workflow: `pull-request-review`

The result shape is defined by [`pull-request-review-result.schema.json`](schemas/pull-request-review-result.schema.json).

Callers must render PR comments and decide whether to publish suggestions from `review_record`.

### Repository Review Result

Workflow: `repository-review`

Repository review is composed of `scan -> case review -> delivery`:

- `scan_summary` is the public scan-stage summary; full discovery / triage outputs are kept in artifacts.
- `case_results[].review_record` is the case-level review output.
- `deliveries[]` contains repository delivery results and publishable artifacts produced by delivery execution.

The result shape is defined by [`repository-review-result.schema.json`](schemas/repository-review-result.schema.json). `case_results[]` expresses case-level public results through `case_id`, `disposition`, `reason`, and `review_record`.

### Repository Deliveries

`deliveries[]` items are `RepositoryDelivery` objects defined by the repository result schema.

A `RepositoryDelivery` is the authoritative input for callers publishing repository delivery draft PRs. Each delivery must carry the generated `patch_diff` and final `file_changes`; display file paths are derived from `file_changes[].path`. `file_changes` is authoritative for applying content; `patch_diff` is a cached review/location view that can be regenerated from the delivery baseline and `file_changes`, and must not be used to reconstruct publishable file contents. `case_ids` links back to case-level review details in top-level `case_results[]`.

### Validation Ownership

JSON Schema owns the transport shape: required fields, JSON types, enums, tagged variants, and additional-field policy. Consumers must validate a complete v1 result before interpreting it; they must not coerce an invalid value into a valid one.

Schema does not replace domain code. Cross-field workflow rules remain with the workflow that makes the decision, while consumers remain responsible for side-effect policy such as safe repository paths, GitHub permissions, publication eligibility, and retry behavior.

## 3. Compatibility

The following changes are breaking changes:

- Removing or renaming a workflow.
- Removing `review_record` or changing the meaning of its core fields.
- Removing `deliveries[]` or changing the meaning of repository delivery result core fields.

The following changes are not breaking changes:

- Adding optional fields.
- Changing internal Python module paths or stage implementation.
