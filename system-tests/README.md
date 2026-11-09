# Cross-service System Tests

Language: English | [中文](README.zh.md)

<!-- doc-default: system-tests.inventory; source=system-tests/ -->
These smoke tests use production code across package or language boundaries without calling a real model. The inventory lists their CI execution policies. All commands below run from the repository root.

## Smoke Inventory

| Smoke scenario / entrypoint | Real boundary exercised | Main assertions | CI execution |
| --- | --- | --- | --- |
| [Review Runs HTTP](review-runs-http/review-runs-http.test.mjs) | GitHub Integration’s Review Runs client → Review Runs HTTP | Empty successful responses resolve without JSON parsing errors; JSON responses still parse. | PR by path + merge queue |
| [Execution submission](execution-submission/execution-submission.test.mjs) | Review Runs’s Execution API client → Execution Gateway HTTP → Temporal | Submit, replay the same submission, and read running status. Stops before Worker execution. | PR by path + merge queue |
| [Memory Catalog client](memory-catalog/test_memory_catalog.py) | agents package’s Memory Catalog client → Memory Catalog HTTP → PostgreSQL | Confirmation required; duplicate registration is idempotent; conflicting intent and bad credentials are rejected. | PR by path + merge queue |
| [Input bundle](input-bundle/test_input_bundle.py) | TypeScript archive/upload → RustFS → Python input preparation | Repeated publication preserves identity; workspace bytes survive transport; wrong digest is rejected. | PR by path + merge queue |
| [Memory operator edit](memory-operator-edit/test_memory_bff.py) | UI BFF → Catalog/PostgreSQL + RustFS | Edit replay creates no extra revision; stale edits conflict; restore returns the prior pointer and readable artifact. | PR by path + merge queue |
| [Execution lifecycle](execution-lifecycle/test_execution_lifecycle.py) | Review Runs coordination → Execution Gateway → Temporal/Worker → RustFS → Review Runs/PostgreSQL | Activity retry, completed execution, readable execution archives, and a durable publication result after reopening the store. Analysis is deterministic; no real model or GitHub publication. | Manual only |

Review Runs HTTP and execution submission share the `Smoke — Service Boundaries` job. Catalog client, input bundle, and operator edit share `Smoke — Memory and Artifacts` so selected tests can reuse disposable services; they remain separate tests with separate path filters. The manual workflow is `Smoke — Execution Lifecycle`. The shared job is an execution-cost choice, not a separate category of smoke tests.

## Directory Layout

Each scenario directory holds its test entrypoint and supporting Node scripts. Shared infrastructure fixtures stay in `conftest.py`; `project_paths.py` defines the shared repository and test paths. The operator-edit test also uses `memory-catalog/catalog-server.mjs`, and the lifecycle test reuses `input-bundle/publish-input.mjs`.

```text
system-tests/
├── conftest.py
├── project_paths.py
├── pytest.ini
├── review-runs-http/
├── execution-submission/
├── memory-catalog/
├── input-bundle/
├── memory-operator-edit/
└── execution-lifecycle/
```

## Prerequisites

Use the Python version from `agents/.python-version`, Node and pnpm versions supported by the participating packages, and a running Docker daemon. Install locked dependencies:

```bash
uv --project agents sync --group test --frozen
pnpm install --frozen-lockfile
```

Install and build only the participants needed for the selected test. The original submission test builds its own packages; the Python probes consume compiled Node modules and require the build commands shown below.

## Review Runs HTTP

This test combines the compiled GitHub Integration’s Review Runs client and Review Runs HTTP routes on an ephemeral loopback port. It protects against parsing an empty HTTP 200 response as JSON while also checking a JSON-returning operation. Storage is stubbed; this test needs no database or Docker daemon.

```bash
pnpm --dir apps/github-integration run build
pnpm --dir services/review-runs run build
node --test system-tests/review-runs-http/review-runs-http.test.mjs
```

## Execution Submission

The execution-submission system test covers the submission boundary. It builds Review Runs and Execution Gateway, starts a disposable Temporal service, and verifies that the Execution API client in Review Runs can submit, replay, and read a run through the real Execution Gateway HTTP surface:

```bash
node --test system-tests/execution-submission/execution-submission.test.mjs
```

Set `TEST_TEMPORAL_ADDRESS` to use an existing disposable Temporal service. Otherwise the test uses the Temporal image configured in `compose.yaml` and removes the temporary Docker container afterward. The test deliberately stops before worker execution, which requires the separately configured agents runtime, workspace, object storage, and model access.

## Model-free Cross-service Smoke Tests

This command runs the Catalog client, input bundle, and memory operator edit scenarios from the inventory above.

Run from the repository root:

```bash
pnpm --dir services/memory-catalog run build
pnpm --dir apps/github-integration run build
pnpm --dir apps/control-plane-ui exec tsc -p tsconfig.server.build.json
uv --project agents run python -m pytest system-tests/memory-catalog/test_memory_catalog.py system-tests/input-bundle/test_input_bundle.py system-tests/memory-operator-edit/test_memory_bff.py -q --durations=10
```

Docker must be available. Fixtures create private containers with random host ports using images from `compose.yaml`, and remove owned containers afterward. These probes do not use deployment database URLs or object-store credentials. A single pytest invocation shares PostgreSQL and RustFS across the selected probes; unused fixtures do not start services. Node services bind ephemeral loopback ports and stop after each test.

The main CI selects probes by their consuming paths through `.github/ci/changed-areas.yml`. It builds only selected participants, and aggregates the smoke job into CI Status. Merge queue candidates run the smoke probes. Tests do not call models, GitHub, or Langfuse; the BFF probe uses HTTP rather than another browser matrix.

## Manual Execution Lifecycle Probe

Run `Smoke — Execution Lifecycle` manually in GitHub Actions; it is not a required check for merging PRs. It exercises the Execution API client in Review Runs and durable stores, Execution Gateway HTTP, Temporal execution and issue workflows, Worker input preparation, execution archive publication to RustFS, and terminal observation back into PostgreSQL. It then reopens the store and claims the persisted publication result.

The analysis activity returns a deterministic no-finding result; its first attempt fails deliberately to exercise retry. Mitigation and verification use their production stages with deterministic model outputs that make no changes. Snapshot restoration, baseline commit resolution, and result persistence still run. This validates orchestration and artifact transport, not model quality, actual repairs, GitHub publication, or memory extraction.

After installing dependencies and building the participants:

```bash
pnpm --dir apps/github-integration run build
pnpm --dir services/execution-gateway run build
pnpm --dir services/review-runs run build
uv --project agents run python -m pytest system-tests/execution-lifecycle/test_execution_lifecycle.py -q --durations=10
```

The driver invokes Review Runs coordination functions directly rather than running its HTTP admission surface and background polling scheduler. PostgreSQL, Temporal and RustFS are real private containers. Service readiness, subprocesses, tests, and CI jobs have time limits; stdout/stderr and pytest durations identify failures and slow boundaries.

## Test Support and Isolation

- `conftest.py` owns disposable PostgreSQL, RustFS and Temporal containers, readiness probes, and Node subprocess cleanup. PostgreSQL uses separate Catalog and Review Runs databases so their schema ledgers cannot collide.
- `memory-catalog/catalog-server.mjs` and `memory-operator-edit/bff-server.mjs` expose production servers on ephemeral loopback ports. They write a JSON ready file only after listening; startup logs stay in the pytest temporary directory.
- `input-bundle/publish-input.mjs` creates a fixed workspace, then uses the production TypeScript manifest, archive, and publication functions. It publishes twice to exercise idempotency.
- `execution-lifecycle/execution-lifecycle.mjs` drives production submission and observation functions and checks that reopening the store preserves a claimable publication result.
- `pytest.ini` bounds individual tests and declares the lifecycle marker. The marker documents the heavier scope; selecting the entire directory locally also runs the lifecycle test.

Fixtures share infrastructure within one pytest invocation, but each test uses unique identities. Containers have no deployment volumes or fixed host ports. Normal teardown removes only resources created by the tests. If the test process is forcibly killed, inspect containers with the `seam-` prefix before removing any leftovers.

## Cost and Diagnostics

Use `--durations=10` to separate setup, test, and teardown costs. Cached local runs do not include dependency installation or image pulls, so they are not a CI latency guarantee. The smoke action compiles selected participants and runs selected tests in a single process; it does not add browser, model, or operating-system matrices.

On failure, inspect pytest's captured Node stderr and the `node-*.log` files in the test temporary directory. A readiness failure includes its startup log. A lifecycle failure may contain the deliberately injected first-attempt analysis exception; it is expected only when retry later succeeds and the terminal assertions pass.

## Maintaining These Tests

Keep assertions on observable transport, artifact, and persistence outcomes. Prefer a small fixture and one concrete failure/retry scenario over broad model-driven cases. When adding a producer or consumer dependency, update [the changed-area model](../.github/ci/changed-areas.yml) and [the smoke action](../.github/actions/check-seams/action.yml) so the relevant test and build run together.

Run script formatting/lint checks from `scripts/` as described in [the scripts guide](../scripts/README.md), plus the affected system tests. Node helpers can be checked with `node --check`; Python tests use pytest-style functions and plain assertions.
