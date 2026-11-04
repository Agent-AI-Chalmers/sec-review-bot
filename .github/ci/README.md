# CI Checks

## Pull Requests

The pull request validators use only the Python standard library and support Python 3.10 or newer. Their workflows intentionally use the hosted runner's `python3` instead of installing the agents package's Python version; these short metadata checks do not depend on the agents runtime.

### Titles

`validate-pr-title.py` validates the repository's pull request title convention. Pass a title as one quoted argument to run the same check locally:

```bash
python3 .github/ci/validate-pr-title.py 'fix(scope): describe the change'
```

### Descriptions

`validate-pr-description.py` validates the required pull request sections and compatibility checkboxes. The template lists all supported classifications, and exactly one must be selected. A breaking change must also explain what breaks and how callers or operators migrate.

To validate a local Markdown file with the same entry point the workflow uses:

```bash
python3 .github/ci/validate-pr-description.py /path/to/pr-body.md
```

Dependabot descriptions are exempt from the human-authored template but must be non-empty.

## Workflow Boundaries

[The main CI workflow](../workflows/ci.yml) owns event triggers, change selection, job dependencies, and the required CI Status check. It calls these workflows at the same revision:

- [Browser checks](../workflows/ci-browser.yml) own the desktop/mobile matrix and failure diagnostics.
- [Contract checks](../workflows/ci-contracts.yml) own the tool-family matrix and generated-artifact freshness checks. The changed-area validator reads this workflow to check tool-directory coverage.

The called workflows use workflow_call; they do not trigger independent PR runs. Their caller jobs remain direct dependencies of CI Status, so their failures contribute to the aggregate. Their file paths are included in the corresponding changed areas.

GitHub displays called jobs beneath their caller names. Branch protection should require CI Status; installations that additionally require individual called-job check names must update those names when adopting this layout.

## Shared Node Setup

<!-- doc-default: shared-node-setup; source=.github/actions/setup-node/action.yml -->
[The Node setup action](../actions/setup-node/action.yml) owns pnpm setup, package-specific Node selection, dependency caching, and frozen-lockfile installation. Call it after checkout with a repository-relative package directory to select the Node version. The action uses the root lockfile for caching and installs the repository workspace once from the root, making dependencies available to all workspace packages.

Package checks and service containers live in the workflows; change conditions stay in [the main CI workflow](../workflows/ci.yml). Changes to the shared action trigger its consuming areas through `changed-areas.yml`.

## Node.js Package Boundaries

After installing dependencies, the shared Node setup action runs the package-boundary checker and its regression tests. To run the check locally after `pnpm install --frozen-lockfile`:

```bash
pnpm run check:boundaries
node --test .github/ci/check-package-boundaries.test.mjs
```

<!-- doc-default: node-package-boundaries; source=.github/ci/check-package-boundaries.mjs -->
Applications and services must not depend on or import other repository packages. Contract tools may use `contracts/codegen`. The checker validates dependency declarations and uses the TypeScript AST to inspect literal references, including type imports, re-exports, dynamic imports, `require`, and file URLs; it also resolves TypeScript path aliases. Contract schemas and fixtures remain available as data. Package tests follow the same boundaries as production code. Tests that combine packages belong under `scripts/system-tests/`. Computed paths assembled at runtime are outside this static check's coverage.

## Shared Python Setup

The Agents job runs directly in the main CI workflow. After checkout, it calls [the Agents check action](../actions/check-agents/action.yml), which owns environment setup, the mypy cache, lint, type checks, and tests. This composite action keeps the steps in a separate file without introducing another job layer.

[The Python setup action](../actions/setup-python/action.yml) installs the agents development environment for the Agents and Repository Scripts jobs. Its `python-version` output supplies the resolved version for the mypy cache key. Documentation checks install Python directly because they do not need agents dependencies.

## Service Checks

Review Runs and Memory Catalog each own a complete job in the main workflow: change conditions, PostgreSQL service configuration, package checks, and integration tests. They reuse Node environment setup, while their check sequences remain explicit and independently editable.

## Automation Validators

Run these checks from the repository root:

```bash
ruby .github/ci/check-ci-status-dependencies.rb
ruby .github/ci/check-review-setup.rb
```

The first checks that every CI job contributes to `CI Status`. The second checks that trusted review setup installs every tracked pnpm package.

## Cross-service Smoke Checks

[The smoke inventory](../../scripts/system-tests/README.md#smoke-inventory) lists all scenarios, their boundaries, and CI policies. Execution submission and Integration-to-Review-Runs HTTP checks run in `Smoke — Service Boundaries`. The `Smoke — Memory and Artifacts` job groups the Catalog client, input bundle, and operator edit tests to share infrastructure.


The `catalog-seam`, `input-bundle-seam`, and `memory-bff-seam` areas select the lightweight probes run by [the smoke action](../actions/check-seams/action.yml). The main workflow owns their single job and final status dependency; the action builds selected participants and runs them in one pytest process to share disposable services. See [the system-test guide](../../scripts/system-tests/README.md#model-free-cross-service-smoke-tests) for commands and coverage limits.

[The execution lifecycle workflow](../workflows/execution-lifecycle.yml) is manual-only and separate from required PR checks. It uses a deterministic analysis activity and does not measure model quality.

## Regression Probes

Run `python3 .github/ci/test_ci.py` from the repository root. The automation job runs the same probes for aggregate failure/cancellation handling and missing dependency rejection. They execute the real scripts and parsed workflow configuration using Python's standard library and Ruby's YAML parser.

## Changed-Area Model

CI does not run every job on every change. The `changes` job decides which areas changed, and each area job runs only when its area did.

That decision lives in **`changed-areas.yml`**:

- each top-level key is an **area** a job gates on;
- the globs under it select the area;
- `ci.yml` reads the file **directly** (`filters: .github/ci/changed-areas.yml`);
- each job gates on its area with `needs.changes.outputs.<area> == 'true'`.

A static `outputs:` map on the `changes` job is a GitHub Actions requirement, so the workflow does restate the area names once. `check-changed-areas.py` checks that restatement against the model, along with what the model cannot state about itself.

## Why the couplings are written down

CI cannot see a cross-package dependency in an import graph, so the couplings are declared as extra globs under the area they affect, and the checker verifies them:

- **Shared contract.** `contracts/**` is read by every consumer of a contract family, so it is listed under `contract-tools`, `review-runs`, `github-integration`, `control-plane-ui`, and `agents`.
- **Generated artifacts.** A contract tool renders a projection into another package, so `contract-tools` lists each one. The checker derives that set from the tools' `generated-artifacts.json` manifests, so a new projection cannot be added without wiring it up.
- **Cross-package tests.** The repository-level `review-runs-http.test.mjs` combines the Integration client and Review Runs server. The `system-tests` area covers both participants and the test entrypoint.

A missed path means a change runs **no job at all** — silent, green CI. That is the class of defect that let an empty-200 response break the client: the job that would have caught it was not wired to the file that changed.

## What the checker does — and does not do

The model is trusted as given: it states _intent_. The checker does not "verify the model"; it checks **completeness** — facts about the repository that no file can state about itself:

- every generated artifact (from the tools' manifests) is covered by `contract-tools`;
- every tracked file is covered by an area or acknowledged in `UNCOVERED`;
- the client↔server seam is wired to both packages;
- no filter is dead (an area declared with no job, or a job gating on an area not declared).

The one thing it is _not_ is a second opinion on the model's own contents — there is no rendered copy of the model left to compare against.

## Files

| File                         | Role                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `changed-areas.yml`          | **The model.** The `dorny/paths-filter` filter set `ci.yml` reads. Edit this. |
| `check-changed-areas.py`     | The completeness checker.                                                     |
| `validate-pr-description.py` | The pull request description validator and local CLI.                         |
| `validate-pr-title.py`       | The pull request title validator and local CLI.                               |

## Editing

Edit `changed-areas.yml`, then run `python3 .github/ci/check-changed-areas.py`.

The checker runs in CI's `automation-config` job (whose filter includes `.github/ci/**`) and fails when:

- a job gates on an area the model does not declare, or the model declares an area no job uses;
- the `changes` job's `outputs:` map does not expose exactly the model's areas;
- a contract tool's generated artifact is not covered by the `contract-tools` area;
- the client↔server seam is no longer wired to both packages;
- a tracked file is covered by neither an area nor the `UNCOVERED` allow-list in the checker.

A tracked file the model does not cover has to be added to an area, or to `UNCOVERED` with a reason. `UNCOVERED` is a short constant (report data, binary assets, root metadata) kept beside the check, so an uncovered path is a deliberate, reviewable choice rather than an oversight.
