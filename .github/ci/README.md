# Changed-area model

CI does not run every job on every change. The `changes` job decides which areas changed, and each area job runs only when its area did.

That decision lives in **`changed-areas.yml`**:

- each top-level key is an **area** a job gates on;
- the globs under it select the area;
- `ci.yml` reads the file **directly** (`filters: .github/ci/changed-areas.yml`);
- each job gates on its area with `needs.changes.outputs.<area> == 'true'`.

A static `outputs:` map on the `changes` job is a GitHub Actions requirement, so the workflow does restate the area names once. `check-changed-areas.mjs` checks that restatement against the model, along with what the model cannot state about itself.

## Why the couplings are written down

CI cannot see a cross-package dependency in an import graph, so the couplings are declared as extra globs under the area they affect, and the checker verifies them:

- **Shared contract.** `contracts/**` is read by every consumer of a contract family, so it is listed under `contract-tools`, `review-runs`, `github-integration`, `control-plane-ui`, and `agents`.
- **Generated artifacts.** A contract tool renders a projection into another package, so `contract-tools` lists each one. The checker derives that set from the tools' `generated-artifacts.json` manifests, so a new projection cannot be added without wiring it up.
- **Cross-package tests.** `review-runs`'s integration suite includes the client↔server seam test, which loads the GitHub-integration client, so a client change must re-run it; both the `review-runs` and `github-integration` areas list the client.

A missed path means a change runs **no job at all** — silent, green CI. That is the class of defect that let an empty-200 response break the client: the job that would have caught it was not wired to the file that changed.

## What the checker does — and does not do

The model is trusted as given: it states *intent*. The checker does not "verify the model"; it checks **completeness** — facts about the repository that no file can state about itself:

- every generated artifact (from the tools' manifests) is covered by `contract-tools`;
- every tracked file is covered by an area or acknowledged in `UNCOVERED`;
- the client↔server seam is wired to both packages;
- no filter is dead (an area declared with no job, or a job gating on an area not declared).

The one thing it is *not* is a second opinion on the model's own contents — there is no rendered copy of the model left to compare against.

## Files

| File | Role |
| --- | --- |
| `changed-areas.yml` | **The model.** The `dorny/paths-filter` filter set `ci.yml` reads. Edit this. |
| `check-changed-areas.mjs` | The completeness checker. |

## Editing

Edit `changed-areas.yml`, then run `node --test .github/ci/check-changed-areas.mjs`.

The checker runs in CI's `automation-config` job (whose filter includes `.github/ci/**`) and fails when:

- a job gates on an area the model does not declare, or the model declares an area no job uses;
- the `changes` job's `outputs:` map does not expose exactly the model's areas;
- a contract tool's generated artifact is not covered by the `contract-tools` area;
- the client↔server seam is no longer wired to both packages;
- a tracked file is covered by neither an area nor the `UNCOVERED` allow-list in the checker.

A tracked file the model does not cover has to be added to an area, or to `UNCOVERED` with a reason. `UNCOVERED` is a short constant (report data, binary assets, root metadata) kept beside the check, so an uncovered path is a deliberate, reviewable choice rather than an oversight.
