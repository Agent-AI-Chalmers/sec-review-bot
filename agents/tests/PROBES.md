# Optional Test Probes

Use this inventory to choose an explicit probe; ordinary test commands and ownership rules are in [README.md](README.md). All Python commands below run from `agents/` unless noted otherwise.

## Model Setup

Real LLM probes are skipped by default and must be enabled one at a time with an explicit environment variable. There is intentionally no "run every LLM probe" switch because some probes use Docker, clone public repositories, or run full workflow agents.

LLM probes intentionally do not load the full application `.env`. They only pick up `LANGFUSE_*` tracing settings and `MODEL_PROVIDERS_CONFIG_TOML` from `agents/.env`; values passed in the shell still take precedence. Probe enable flags such as `RUN_LLM_SKILL_CASES=1` should be set explicitly in the command that runs the probe.

Probe-agent tests also require `LLM_TEST_DEPLOYMENT=<deployment name>`. Product workflow probes use the normal agent deployment bindings, so they do not use `LLM_TEST_DEPLOYMENT`.

Deployments are read from `config/model-providers.toml` by default. Set `MODEL_PROVIDERS_CONFIG_TOML` to select another configuration.

For a probe agent, select a deployment explicitly:

```bash
RUN_LLM_SKILL_CASES=1 LLM_TEST_DEPLOYMENT=<deployment> \
uv run python -m pytest tests/skills/test_llm.py -q -s
```

For a product workflow, use its normal deployment binding:

```bash
RUN_LLM_ISSUE_REVIEW_INTEGRATION=1 \
uv run python -m pytest tests/workflows/issue/test_llm_mixed_claims.py -q -s
```

Use a focused file, pytest node ID, or `-k` expression rather than enabling unrelated probes. Docker, public checkouts, and full workflow agents can make a probe expensive even when its fixture is small.

## Real-Model Inventory

| Probe                                                                                      | Enable with                                                                                                                      | Requirements                                                                      | Purpose                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Context summarization](runtime/test_llm_context_summarization.py)                         | `RUN_LLM_CONTEXT_SUMMARIZATION_INTEGRATION=1`                                                                                    | `LLM_TEST_DEPLOYMENT`                                                             | Checks real summarization middleware behavior.                                                                                                                                                                                                                                   |
| [Project instructions](runtime/test_llm_project_instructions.py)                           | `RUN_LLM_PROJECT_INSTRUCTIONS_INTEGRATION=1`                                                                                     | `LLM_TEST_DEPLOYMENT`                                                             | Uses a local workspace to check that the agent uses a preloaded project validation command, inspects source, and leaves guidance unchanged.                                                                                                                                      |
| [Filesystem newline edits](filesystem/test_llm_newline_edits.py)                           | `RUN_LLM_NEWLINE_EDITS=1`                                                                                                        | `LLM_TEST_DEPLOYMENT`                                                             | Exercises real read/edit middleware on CRLF, mixed endings and missing final newline; checks the resulting LF-normalized bytes.                                                                                                                                                  |
| [Memory probes](memory/README.md#real-model-probes)                                        | `RUN_LLM_MEMORY_MIDDLEWARE_INTEGRATION=1`, `RUN_LLM_MEMORY_EXTRACTION_INTEGRATION=1`, `RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT`                                                             | Checks topic use, extraction, learning maintenance, and pure reorganization. See [memory commands](memory/README.md#real-model-probes).                                                                                                                                          |
| [Bundled skill cases](skills/test_llm.py)                                                  | `RUN_LLM_SKILL_CASES=1`                                                                                                          | `LLM_TEST_DEPLOYMENT`                                                             | Runs JSON-defined prompted, discovery, and compare cases, including web, CI, and CWE checks. Compare cases record paired Skills OFF/ON outputs without automatically declaring a winner.                                                                                         |
| [Issue review narratives](workflows/issue/test_llm_mixed_claims.py)                        | `RUN_LLM_ISSUE_REVIEW_INTEGRATION=1`                                                                                             | issue analyzer binding                                                            | Runs the issue analyzer on small synthetic cases, including non-dataflow evidence-shape probes for concurrency, cryptography, delegated authority, and cancellation.                                                                                                             |
| [False-positive precedent](workflows/pull_request/test_llm_false_positive_precedents.py)   | `RUN_LLM_FALSE_POSITIVE_PRECEDENT_INTEGRATION=1`                                                                                 | pull-request analyzer binding                                                     | Checks precedent-guided false-positive handling.                                                                                                                                                                                                                                 |
| [Triage workflow](agents/triage/test_llm_workflow.py)                                      | `RUN_LLM_TRIAGE_WORKFLOW_INTEGRATION=1`                                                                                          | triage binding                                                                    | Checks candidate retention and suppression on scanner-shaped input, including use of mounted guidance.                                                                                                                                                                           |
| [Delivery workbench](delivery_stages/planning/test_llm_workbench_planning.py)              | `RUN_LLM_DELIVERY_WORKBENCH_INTEGRATION=1`                                                                                       | delivery planning binding                                                         | Checks delivery planning workbench use.                                                                                                                                                                                                                                          |
| [Combined patch synthesis](delivery_stages/execution/test_llm_patch_synthesis_conflict.py) | `RUN_LLM_PATCH_SYNTHESIS_CONFLICT=1`                                                                                             | delivery execution binding, Docker sandbox                                        | Checks that contradictory repair intents produce no commit while compatible repairs are combined; executes model-written code only inside Docker.                                                                                                                                |
| [CodeGraph MCP smoke](mcp/test_llm_codegraph.py)                                           | `RUN_LLM_CODEGRAPH_MCP_INTEGRATION=1`                                                                                            | `LLM_TEST_DEPLOYMENT`, `codegraph` on `PATH`                                      | Checks local CodeGraph MCP wiring.                                                                                                                                                                                                                                               |
| [Analyzer Docker + CodeGraph](mcp/test_llm_analyzer_codegraph.py)                          | `RUN_LLM_ANALYZER_CODEGRAPH_DOCKER_INTEGRATION=1`                                                                                | repository analyzer binding, `sec-review-bot-workspace:tools` image               | Compares filesystem-only analysis with explicitly requested CodeGraph evidence on a cross-file case; does not test autonomous tool discovery.                                                                                                                                    |
| [CodeGraph public checkout](mcp/test_llm_codegraph_real_checkout.py)                       | `RUN_LLM_CODEGRAPH_REAL_CHECKOUT_INTEGRATION=1`                                                                                  | issue analyzer binding, `sec-review-bot-workspace:tools` image, network for clone | Runs a pinned public checkout with explicitly requested ON-arm tool evidence. See [CodeGraph comparisons](mcp/README.md#codegraph-comparisons).                                                                                                                                  |
| [MCP cases](mcp/test_llm.py)                                                               | `RUN_LLM_MCP_CASES=1`                                                                                                            | relevant product agent bindings, `sec-review-bot-workspace:tools` image           | Runs data-driven MCP discovery and paired comparison cases through normal product workflows. Transport and state continuity are covered by separate no-model capability tests.                                                                                                   |
| [External tool cases](external_tools/test_llm.py)                                          | `RUN_LLM_EXTERNAL_TOOL_CASES=1`                                                                                                  | product agent bindings, base and `sec-review-bot-workspace:tools` images          | Runs Joern and Playwright CLI discovery cases plus pinned public-checkout comparisons with skills and MCP disabled. Comparison OFF arms use the base image so the CLI is genuinely unavailable. Installation and CLI behavior are covered by separate no-model capability tests. |

Probe names link to their entrypoints or domain instructions. Use those files with the enable flags above.

For issue evidence-shape probes, use `tests/workflows/issue/test_llm_non_dataflow_evidence.py`. Set `NON_DATAFLOW_EVIDENCE_PROBE_REPEATS` between 1 and 10 to repeat cases; results are retained in `.agent-artifacts/non-dataflow-evidence/`, overridden by `NON_DATAFLOW_EVIDENCE_OUTPUT_DIR`.

Build the tools image for probes that require it:

```bash
docker build -f agents/docker/workspace-tools.Dockerfile \
  -t sec-review-bot-workspace:tools \
  agents
```

## Other Environment-Dependent Tests

| Test group                   | Entrypoint                                                                                                      | Prerequisites and CI policy                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP capability               | `tests/mcp/test_capability.py`                                                                                  | Docker and `sec-review-bot-workspace:tools`; ordinary CI does not build this image, so capability cases skip when it is absent. See [MCP tests](mcp/README.md).                                                                           |
| External CLI capability      | `tests/external_tools/test_capability.py`                                                                       | Docker and `sec-review-bot-workspace:tools`; skips when the image is absent. See [external tool tests](external_tools/README.md).                                                                                                         |
| S3 adapter                   | `tests/artifacts/test_s3_adapter_integration.py`, S3 integration case in `tests/artifacts/test_s3_adapter.py`   | `SEC_REVIEW_TEST_S3_ENDPOINT`, `SEC_REVIEW_TEST_S3_BUCKET` and suitable AWS credentials; skips without endpoint or bucket.                                                                                                                |
| Execution archive recovery   | `tests/execution_archives/test_recovery_integration.py`                                                         | Same S3 configuration; exercises recovery after a successful upload whose response is lost.                                                                                                                                               |
| Legacy Python runtime        | `tests/filesystem/test_legacy_python_skill_loading.py`                                                          | `LEGACY_PYTHON_TEST_IMAGE` selecting Python 3.5 or 3.6; see the command below.                                                                                                                                                            |
| GitHub Integration S3 upload | `apps/github-integration/test/integration/artifacts/s3-input-storage.integration.test.ts` (repository-relative) | Run `pnpm run test:integration` from `apps/github-integration/`; requires dedicated S3 configuration. The main CI deliberately omits this suite.                                                                                          |
| Execution lifecycle          | `system-tests/execution-lifecycle/test_execution_lifecycle.py` (repository-relative)                            | Model-free, private PostgreSQL/Temporal/RustFS containers and compiled service participants; runs only through the manual workflow or a local command. See [system tests](../../system-tests/README.md#manual-execution-lifecycle-probe). |

Ordinary Docker backend tests are selected by CI and build their own small image; they skip only when Docker is unavailable. Temporal time-skipping tests are also selected, but skip if their test server cannot start. Neither group is excluded merely because it carries the `integration` marker. A successful CI status alone does not establish that environment-dependent cases executed.

For the legacy runtime test, use an existing image whose `python3` selects Python 3.5 or 3.6:

```bash
LEGACY_PYTHON_TEST_IMAGE=my-local-python35-image \
uv run python -m pytest tests/filesystem/test_legacy_python_skill_loading.py -q
```

This exercises real skill discovery, binary transfers, file operations, and symlink rejection. Syntax compatibility guards still run in the ordinary suite.
