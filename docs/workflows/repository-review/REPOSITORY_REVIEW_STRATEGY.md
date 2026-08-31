# Repository Review Strategy

Language: English | [中文](REPOSITORY_REVIEW_STRATEGY.zh.md)

## Scope

`repository-review` is a repository-level workflow independent of `issue-review` and `pull-request-review`. It screens the repository, condenses file-level suspicious points into a small number of high-value problem clusters called `case`s, sends worthwhile cases through `analyzer / cvss-v4-scoring / mitigator / verifier`, and publishes a repository summary plus a small number of draft PRs.

The workflow favors broad initial coverage, later denoising and consolidation, and final output that a reviewer can inspect. It is not a "one agent understands the whole repository" design, and it does not try to maximize raw finding count.

## Stage Model

The workflow is organized into three segments:

1. `scan / case formation`: `discovery -> triage`
2. `per-case review`: run `analyzer / cvss-v4-scoring / mitigator / verifier` for each retained `case`
3. `delivery`: `delivery-planning -> delivery-execution`, followed by GitHub App publishing summary and draft PRs

`cvss-v4-scoring` runs in parallel with the mitigation / verification path for the same case. Delivery execution calls the patch-synthesis submodule for `combined` deliveries.

## Stage Intent

### `discovery`

Discovery screens local chunks instead of giving an agent free-form repository exploration.

Files are chunked by path proximity and context budget. Each chunk invokes the model once and produces candidates for that chunk. The chunk contains nearby files, enough for local cross-file clues without becoming whole-repository context.

Discovery emits structured `candidate`s with location, category, rationale, and confidence. It stops short of vulnerability confirmation and `vulnerability_type` / `CWE` classification, keeping this stage high-recall and lightweight.

Its job is initial coverage, not final confirmation, cross-file root-cause merging, or report generation.

### `triage`

`triage` sits after `discovery` and before `analyzer`. It denoises high-recall file-level candidates and condenses them into a small number of high-value cases.

Triage uses observable repository evidence to retain, suppress, or merge candidates. A merge means the candidates describe the same observable security issue, not merely a similar pattern.

It should not over-merge just because candidates share a file, route, or vulnerability class. It should also avoid early suppression just because behavior is documented, marked internal/debug/legacy, or protected by an incomplete guard. Only cases worth further analysis enter analyzer.

### `analyzer`

Only cases retained by `triage` enter `analyzer`. This stage reuses the narrative-first approach and outputs narratives ordered by `priority`, locations, source facts, sink facts, proof gaps, vulnerability type / CWE classification, and reviewer-facing summary.

Analyzer turns candidate clues into evidence-backed conclusions before mitigation or delivery begins. Mitigation should not start from vague suspicion.

`analyzer` must respect case scope boundaries:

- it may confirm, narrow, or reject the current case;
- but it must not rewrite the current case into another independent issue while continuing under the same `case_id`;
- nearby independent issues must not enter the current case's `narratives`, mitigation, verification, or delivery execution.

### `cvss-v4-scoring`

`cvss-v4-scoring` runs after `analyzer`. It decides CVSS v4 Base metrics from analyzer facts and outputs standardized `vector / base_score / severity`. The score is report-layer risk expression, not the main scheduling or repair-priority signal.

The stage performs targeted fact checks and standardized scoring within the current case. It does not revisit analyzer's vulnerability judgment or use post-fix state.

### `mitigator`

`mitigator` serves high-confidence, converged issues. It keeps patches close to the real boundary or sink, with minimal scope and reviewable changes. Broad discovery, free-form reanalysis, and large refactors belong outside this stage.

### `verifier`

`verifier` independently reviews analyzer and mitigator output. It checks whether analyzer overstated the claim, whether the patch fixes the target, and whether the patch introduces obvious side effects or bypasses.

In repository review, `verifier` checks both the report and the patch and provides the final quality gate for keep/blocked decisions.

To reduce the risk that a mitigation report claims a patch was applied while verifier sees baseline code and incorrectly concludes the patch was not applied, repository verifier uses two input views:

- `/workspace`: read-only baseline view without the patch
- `/workspace-patched`: read-only view built temporarily during verifier stage by applying `workspace.patch` to a clean workspace snapshot

When `workspace.patch` exists and applies cleanly, `patch_coverage` is judged primarily from `/workspace-patched`; `/workspace` is used only for baseline comparison. If the patched view cannot be built, verification fails instead of judging patch coverage from baseline code.

### `delivery-planning`

Only verified cases enter delivery-planning / delivery-execution.

`delivery-planning` groups verified cases into delivery units. Its main facts come from prepared per-case outputs, not the final shared workspace state. It prefers case item payload, mitigation overview, changed files, and workbench state; it reads per-case patches only when those inputs cannot explain a delivery coupling question.

Merge decisions are based on whether delivery must be bound to the same PR, not whether cases are semantically related. Create a `combined` delivery only when coordinated execution, shared patch scope, release dependency, or split-publish execution conflict requires it; otherwise keep `single`. Delivery execution consumes that plan and produces the public delivery result. The app consumes the result and does not infer merge strategy backward.

### `delivery-execution`

Delivery execution takes the plan from `delivery-planning` and produces the outputs the GitHub app can publish. A `single` delivery packages the file changes already produced for one case. A `combined` delivery asks the patch-synthesis submodule to produce one coordinated final file state.

Execution order is fixed:

1. determine delivery execution units from delivery-planning constraints;
2. call the patch-synthesis submodule for `combined` deliveries;
3. assemble delivery result and write only actually publishable delivery outputs.

Delivery execution has two paths by delivery strategy:

- `single`: does not call an agent, does not enter the patch synthesis concurrency pool, and does not re-apply or copy case `workspace.patch`. It directly consumes the corresponding case's `review_record.mitigation.file_changes` and projects them into a publishable delivery output. If there are no publishable `file_changes`, that delivery is not written into public `deliveries[]`.
- `combined`: calls the patch-synthesis agent in an isolated clean workspace, consumes that delivery's case summaries, verifier results, and reference patches, and directly generates the final file state for that delivery. Concurrency is controlled by `REPOSITORY_PATCH_SYNTHESIS_MAX_CONCURRENCY`, default `4`.
