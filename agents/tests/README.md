# Tests

Tests are organized by the production behavior or domain they protect. Test mechanism, runtime cost, and use of a real model are execution attributes, not ownership boundaries.

## Test Ownership

Put a test next to the domain whose contract would be wrong if the test failed:

- Runtime behavior belongs under `tests/runtime/`.
- Review-stage behavior belongs under `tests/review_stages/`.
- Workflow behavior belongs under `tests/workflows/<workflow>/`.
- Tests of the production `sec_review_agents.llm` package belong under `tests/llm/`.

A test does not belong under `tests/llm/` merely because it uses a language model. For example, a real-model issue analyzer probe still belongs to the issue workflow, and a summarization probe belongs to runtime. This keeps model-backed and deterministic tests of the same contract close together.

Use `integration` and `llm` markers to describe how a test executes. Do not use those markers to decide its directory.

## Running Tests

Run tests from `agents/` so the local project and environment are explicit:

```bash
uv run python -m pytest
```

During development, prefer the narrowest relevant file or directory. Marker selection can further control execution:

```bash
uv run python -m pytest tests/workflows/issue -q
uv run python -m pytest -m integration -q
uv run python -m pytest -m llm -q
```

Real-model tests remain skipped unless their probe-specific environment variable is enabled. Selecting the `llm` marker alone does not opt into external model calls.

## Case Corpora

Data-driven cases belong to the domain that interprets their inputs and oracle. Use this shape when a domain has enough cases to justify a corpus:

```text
tests/<owner>/cases/
|-- models.py
|-- loader.py
|-- runner.py
`-- <case-id>/
    |-- case.json
    `-- workspace/
```

`case.json` contains the case input, expectations, and stable oracle. `models.py` defines that data contract, `loader.py` validates and discovers cases, and `runner.py` executes them. Keep probe-specific assertions in the owning test rather than expanding the shared oracle for one experiment.

The `workspace/` directory is an input repository, not test implementation code. Type checkers exclude case workspaces for that reason. Do not add tests that merely assert fixture files exist or restate loader validation; exercise the corpus through the consumer that gives it meaning.

## Shared Test Infrastructure

Keep a helper local when it has one owning test or domain. A top-level test module is appropriate only when multiple independent domains share a narrow, stable responsibility. Current examples include `tests/llm_probe.py`, `tests/contract_fixtures.py`, `tests/input_bundle.py`, and `tests/temporal_test_utils.py`.

Name shared modules after the capability they provide. Avoid generic `helpers`, `support`, or `utils` packages that erase ownership and accumulate unrelated behavior. Shared infrastructure should reduce repeated setup without becoming a framework around the tests.

## Real-Model Probes

Real-model probes live with their owning test domains. Shared probe setup lives in `tests/llm_probe.py`; runtime probes live under `tests/runtime/` or the stage they exercise.

Real LLM probes are skipped by default and must be enabled one at a time with an explicit environment variable. There is intentionally no "run every LLM probe" switch because some probes use Docker, clone public repositories, or run full workflow agents.

LLM probes intentionally do not load the full application `.env`. They only pick up `LANGFUSE_*` tracing settings and `MODEL_PROVIDERS_CONFIG_TOML` from `agents/.env`; values passed in the shell still take precedence. Probe enable flags such as `RUN_LLM_SKILL_CASES=1` should be set explicitly in the command that runs the probe.

Probe-agent tests also require `LLM_TEST_DEPLOYMENT=<deployment name>`. Product workflow probes use the normal agent deployment bindings, so they do not use `LLM_TEST_DEPLOYMENT`.

### Light Probes

| Probe | Enable with | Extra requirements | Purpose |
| --- | --- | --- | --- |
| Changed-files response correction | `RUN_LLM_STRUCTURED_CORRECTION_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks that the model corrects a rejected changed-files declaration in the same thread. |
| Context summarization | `RUN_LLM_CONTEXT_SUMMARIZATION_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks real summarization middleware behavior. |
| Memory probes | `RUN_LLM_MEMORY_MIDDLEWARE_INTEGRATION=1`, `RUN_LLM_MEMORY_EXTRACTION_INTEGRATION=1`, `RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks memory topic use, trajectory extraction, and candidate memory-tree maintenance. |
| Bundled skill cases | `RUN_LLM_SKILL_CASES=1` | `LLM_TEST_DEPLOYMENT` | Runs JSON-defined prompted, discovery, and compare cases, including web, CI, and CWE checks. Compare cases record paired Skills OFF/ON outputs without automatically declaring a winner. |
| CodeGraph MCP smoke | `RUN_LLM_CODEGRAPH_MCP_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT`, `codegraph` on `PATH` | Checks local CodeGraph MCP wiring. |

Example:

```bash
cd agents
RUN_LLM_SKILL_CASES=1 \
LLM_TEST_DEPLOYMENT=anthropic_strong \
uv run python -m pytest tests/skills/test_llm.py -q -s
```

By default, deployments are read from `config/model-providers.toml`. If you keep the TOML somewhere else, either set `MODEL_PROVIDERS_CONFIG_TOML` in the command or put it in `agents/.env`.

Memory probes are intentionally split so regressions are easy to isolate:

```bash
cd agents

RUN_LLM_MEMORY_MIDDLEWARE_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=<deployment> \
uv run python -m pytest tests/memory/test_llm_middleware.py -q -s

RUN_LLM_MEMORY_EXTRACTION_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=<deployment> \
uv run python -m pytest tests/memory/test_llm_extraction.py -q -s

RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=<deployment> \
uv run python -m pytest tests/memory/test_llm_maintenance.py -q -s

```

### Product Workflow Probes

These use real workflow agents and normal deployment bindings.

| Probe | Enable with | Extra requirements | Purpose |
| --- | --- | --- | --- |
| Issue review narratives | `RUN_LLM_ISSUE_REVIEW_INTEGRATION=1` | issue analyzer binding | Runs the issue analyzer on small synthetic cases, including non-dataflow evidence-shape probes for concurrency, cryptography, delegated authority, and cancellation. |
| False-positive precedent | `RUN_LLM_FALSE_POSITIVE_PRECEDENT_INTEGRATION=1` | pull-request analyzer binding | Checks precedent-guided false-positive handling. |
| Delivery workbench | `RUN_LLM_DELIVERY_WORKBENCH_INTEGRATION=1` | delivery planning binding | Checks delivery planning workbench use. |
| Triage workflow | `RUN_LLM_TRIAGE_WORKFLOW_INTEGRATION=1` | triage binding | Checks candidate retention and suppression on scanner-shaped input, including use of mounted guidance. |

Example:

```bash
cd agents
RUN_LLM_ISSUE_REVIEW_INTEGRATION=1 \
uv run python -m pytest tests/workflows/issue/test_llm_mixed_claims.py -q -s
```

The non-dataflow evidence-shape probe reads issue fixtures from `tests/workflows/issue/cases/`. Repeat every case and retain each analyzer result for comparison with:

```bash
cd agents
RUN_LLM_ISSUE_REVIEW_INTEGRATION=1 \
NON_DATAFLOW_EVIDENCE_PROBE_REPEATS=3 \
uv run python -m pytest tests/workflows/issue/test_llm_non_dataflow_evidence.py -q -s
```

Results are written under `.agent-artifacts/non-dataflow-evidence/` by default. Set `NON_DATAFLOW_EVIDENCE_OUTPUT_DIR` to use another directory. The repeat count must be between 1 and 10.

### Heavy Probes

Heavy probes should be run deliberately. They may start Docker containers, run full analyzer workflows, clone public repositories, or retain artifacts for manual inspection.

| Probe | Enable with | Extra requirements | Purpose |
| --- | --- | --- | --- |
| Analyzer Docker + CodeGraph | `RUN_LLM_ANALYZER_CODEGRAPH_DOCKER_INTEGRATION=1` | repository analyzer binding, `sec-review-bot-workspace:tools` image | Compares analyzer behavior with and without CodeGraph on a cross-file case. |
| CodeGraph public checkout | `RUN_LLM_CODEGRAPH_REAL_CHECKOUT_INTEGRATION=1` | issue analyzer binding, `sec-review-bot-workspace:tools` image, network for clone | Runs a pinned public vulnerable checkout comparison. |
| MCP cases | `RUN_LLM_MCP_CASES=1` | relevant product agent bindings, `sec-review-bot-workspace:tools` image | Runs data-driven MCP discovery and paired comparison cases through normal product workflows. Transport and state continuity are covered by separate no-model capability tests. |
| External tool cases | `RUN_LLM_EXTERNAL_TOOL_CASES=1` | product agent bindings, base and `sec-review-bot-workspace:tools` images | Runs Joern and Playwright CLI discovery cases plus pinned public-checkout comparisons with skills and MCP disabled. Comparison OFF arms use the base image so the CLI is genuinely unavailable. Installation and CLI behavior are covered by separate no-model capability tests. |

Build the workspace tools image when a probe needs CodeGraph or Playwright:

```bash
docker build -f agents/docker/workspace-tools.Dockerfile \
  -t sec-review-bot-workspace:tools \
  agents
```

Heavy probes usually write artifacts under `.agent-artifacts/`.
MCP cases retain each run under `.agent-artifacts/mcp-cases/`; set `MCP_CASE_OUTPUT_DIR` to override that location.
External tool cases retain each run under `.agent-artifacts/external-tool-cases/`; set `EXTERNAL_TOOL_CASE_OUTPUT_DIR` to override that location.
