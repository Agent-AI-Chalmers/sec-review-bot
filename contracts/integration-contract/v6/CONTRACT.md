# Integration Contract v6

Language: English | [中文](CONTRACT.zh.md)

This document defines the workflow `input` submitted through the Execution API and the `result` returned after a run completes. For the HTTP transport itself, see [the Execution API OpenAPI document](../openapi.yaml).

Representative JSON fixtures live under [`fixtures`](fixtures). Python and TypeScript contract tests both read these fixtures.

The v6 public result exposes final results for each workflow instead of internal stage execution details:

- issue review and pull request review return one `ReviewRecord`.
- repository review returns a scan summary, case-level `ReviewRecord` projections, and repository-only delivery results.

## 1. Workflow Inputs

This section defines the workflow `input` object inside the HTTP create-run request body. HTTP envelope fields such as `run_id` and `runtime` are defined in [the Execution API OpenAPI document](../openapi.yaml).

Every workflow input includes:

- `contract_version: "v6"`
- `input_bundle`
- `review_intent`

### Input Bundle Boundary

`input_bundle` is an immutable artifact reference to a complete input bundle archive. The caller prepares and uploads the archive; the Execution Worker verifies it and materializes it into a local run-scoped directory before reading the manifest or executing a workflow.

The v6 Execution Worker supports local `file:` and durable `s3:` URIs. Storage endpoint, region, and credentials are deployment configuration and never come from workflow input. Presigned HTTP URLs are not durable artifact references.

The caller owns the input bundle. The Execution Worker and its stages own runtime state such as `artifact_paths`, stage artifact roots, writable stage workspaces, retry state, and delivery assignments.

The `tar.zst` archive must contain `manifest.json`, the workspace snapshot, history, and any declared incremental window. The manifest shape is defined by [`input-bundle-manifest.schema.json`](schemas/input-bundle-manifest.schema.json). It declares the contract version and bundle-relative paths. The Execution Worker parses those paths into internal local `bundle_paths`. Callers must not provide `bundle_paths` directly.

The `input_bundle` object shape is defined by [`common.schema.json`](schemas/common.schema.json); `uri` accepts a `file:` or `s3:` reference.

Repository scan target (`scan_target` in [`repository-review-input.schema.json`](schemas/repository-review-input.schema.json)):

- `target_branch` is the branch/ref label selected by the caller.
- `base_sha` / `head_sha` / `commit_shas` describe the scan delta window, corresponding semantically to PR workflow base/head/commit context.
  - for full scans, `base_sha` is `null` and `commit_shas` is empty;
  - for incremental scans, `base_sha..head_sha` defines the window, and `commit_shas` describes the commits in that window.

Repository scan scope (`scan_scope` in the same schema) declares `paths_ignore` and `incremental_changed_files`.

Each workflow input has its own schema:

| Workflow | Schema |
| --- | --- |
| `issue-review` | [`issue-review-input.schema.json`](schemas/issue-review-input.schema.json) |
| `pull-request-review` | [`pull-request-review-input.schema.json`](schemas/pull-request-review-input.schema.json) |
| `repository-review` | [`repository-review-input.schema.json`](schemas/repository-review-input.schema.json) |

Pull request inputs carry a `pr` subject describing the pull request as this run sees it. Two of its fields deserve a note because the schema cannot express their relationship:

- `base_sha` and `head_sha` identify the pull request itself and stay constant for the run.
- `review_window` states the range the run covers. On `synchronize` it is narrower than `base_sha..head_sha`, because the run covers only the commits pushed since the previous review. `review_window.reason` records why a run fell back to the full range.

The Execution API provider and Execution Worker both validate input at their process boundaries. All workflows require these common fields:

- `contract_version`
- `input_bundle`
- `review_intent`

`review_intent.objective` declares the review objective:

- `audit`
- `repair` (`issue-review` only; pull request and repository workflows currently require `audit`)

`review_intent.test_changes` is optional and constrains the final mitigation patch. If omitted, it defaults to `allow`:

- `allow`: the final mitigation patch may contain reasonable test changes.
- `deny`: the final mitigation patch must not contain test changes; tests may only be used as temporary validation work.

`test_changes` is a prompt constraint for the agent. It is not mechanical enforcement; the Execution Worker does not classify repository paths as tests or reject file changes based on path heuristics.

`setup_declaration` is an optional string carrying the repository's setup declaration (the contents of `.sec-review/setup.yml` on the base-repo default branch). It is inline declaration text, not a path: callers fetch the file and pass its contents. Omission means the environment stays unbootstrapped. The declaration is parsed strictly and executed inside the sandbox before the agent starts. Trust in its provenance is the caller's responsibility: it comes from the base-repo default branch, and the Execution Worker does not re-verify it against a source.

`repository-review` uses `scan_target` and `scan_scope` as its explicit cost and coverage boundary.

The `scan_mode` selects the window shape:

| Mode | Required / shape |
| --- | --- |
| `full` | `scan_scope.incremental_changed_files: []`; `base_sha: null`; `commit_shas: []` |
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

The Execution Worker produces this projection from internal stage output. Its `ReviewRecord` builder intentionally keeps only the public fields: unknown internal fields are discarded, malformed optional scalar values become `null`, and malformed list members are omitted. This degradation policy applies only while producing optional report detail. The completed public result must still validate against the full workflow result schema before it crosses the Execution API boundary.

Runtime exceptions are not part of `ReviewRecord`. If analyzer / mitigator / verifier / discovery / delivery synthesis fails at runtime, the workflow run should fail and the Execution API should return a structured execution error. Do not publish stage-level `status="error"`, `unavailable`, or other compatibility error projections in the public result.

> *CVSS is an optional score shown in the report, not the pass/fail signal for the review. If repository CVSS scoring fails after the case review itself succeeds, publish `ReviewRecord.cvss` as `null` and keep the scoring failure details in diagnostics and artifacts.*

`verification.patch_coverage="full"` requires the verifier to report full coverage for the patch target. Partial coverage remains unresolved and must not enter repository delivery / draft PR publication.

`verification.regression_status` reports whether focused regression, behavior-preservation, build, or test evidence supports the patched workspace. It is separate from security-target coverage: a patch can fully cover the reviewed security claim while tests were not run or while regression readiness remains unresolved.

`verification.resolution_next_step` describes the next action after verifier judgment: `none` means no further action is needed; `retry-ai` means there is a concrete patch gap that bounded AI mitigation can continue fixing; `manual-review` means remaining work requires human review, administrator action, credential rotation, history cleanup, deployment/configuration changes, or another capability outside normal workspace patching.

### Issue Review Result

Workflow: `issue-review`

Input keeps the existing issue input contract and expresses review intent through `review_intent`. This is the workflow where `review_intent.objective = "repair"` changes analyzer stance. Downstream mitigation still depends only on the analyzer's structured result.

The result shape is defined by [`issue-review-result.schema.json`](schemas/issue-review-result.schema.json).

The `two-stage` and `single-agent` issue strategies (`--strategy` on the local issue CLI) are local evaluation / ablation paths. They start as local-only Temporal workflows on the `issue-review` workflow, but they are not part of the standard public execution contract.

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

The GitHub summary renderer can render confirmed cases that did not reach the delivery gate as blocked case cards from `case_results[]`.

### Repository Deliveries

`deliveries[]` items are `RepositoryDelivery` objects defined by the repository result schema.

A `RepositoryDelivery` is the authoritative input for callers publishing repository delivery draft PRs. Each delivery must carry the generated `patch_diff` and final `file_changes`; display file paths are derived from `file_changes[].path`. `file_changes` is authoritative for applying content; `patch_diff` is the diff/reference view and must not be used to reconstruct publishable file contents. `case_ids` links back to case-level review details in top-level `case_results[]`.

### Validation Ownership

JSON Schema owns the transport shape: required fields, JSON types, enums, tagged variants, and additional-field policy. Consumers must validate a complete v6 result before interpreting it; they must not coerce an invalid value into a valid one.

Schema does not replace domain code. Cross-field workflow rules remain with the workflow that makes the decision, while consumers remain responsible for side-effect policy such as safe repository paths, GitHub permissions, publication eligibility, and retry behavior.

## 3. Compatibility

The following changes are breaking changes:

- Removing or renaming a workflow.
- Removing `review_record` or changing the meaning of its core fields.
- Removing `deliveries[]` or changing the meaning of repository delivery result core fields.

The following changes are not breaking changes:

- Adding optional fields.
- Changing internal Python module paths or stage implementation.
