# Real LLM Integration Probes

Most integration tests run without model access. Real LLM probes are skipped by default and must be enabled one at a time with an explicit environment variable. There is intentionally no "run every LLM probe" switch because some probes use Docker, clone public repositories, or run full workflow agents.

LLM probes intentionally do not load the full application `.env`. They only pick up `LANGFUSE_*` tracing settings and `MODEL_PROVIDERS_CONFIG_TOML` from `agents/.env`; values passed in the shell still take precedence. Probe enable flags such as `RUN_LLM_CWE_SKILL_INTEGRATION=1` should be set explicitly in the command that runs the probe.

Probe-agent tests also require `LLM_TEST_DEPLOYMENT=<deployment name>`. Product workflow probes use the normal agent deployment bindings, so they do not use `LLM_TEST_DEPLOYMENT`.

## Light Probes

| Probe | Enable with | Extra requirements | Purpose |
| --- | --- | --- | --- |
| Structured response correction | `RUN_LLM_STRUCTURED_CORRECTION_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks retry/correction behavior for structured output. |
| Context summarization | `RUN_LLM_CONTEXT_SUMMARIZATION_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks real summarization middleware behavior. |
| Memory probes | `RUN_LLM_MEMORY_MIDDLEWARE_INTEGRATION=1`, `RUN_LLM_MEMORY_EXTRACTION_INTEGRATION=1`, `RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION=1`, `RUN_LLM_MEMORY_LIFECYCLE_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks memory topic use, transcript extraction, maintenance, and the full extraction-to-maintenance lifecycle. |
| CWE skill | `RUN_LLM_CWE_SKILL_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks that a probe agent can read and apply the CWE skill. |
| Reference skill probes | `RUN_LLM_REFERENCE_SKILL_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT` | Checks explicit progressive-disclosure skill reading. |
| Reference skill contrast | `RUN_LLM_REFERENCE_SKILL_CONTRAST=1` | `LLM_TEST_DEPLOYMENT` | Compares natural review behavior with and without reference skills. |
| Language/framework skill probe | `RUN_LLM_LANGUAGE_FRAMEWORK_SKILL_PROBE=1` | `LLM_TEST_DEPLOYMENT` | Checks explicit language/framework skill reading. |
| CodeGraph MCP smoke | `RUN_LLM_CODEGRAPH_MCP_INTEGRATION=1` | `LLM_TEST_DEPLOYMENT`, `codegraph` on `PATH` | Checks local CodeGraph MCP wiring. |

Example:

```bash
cd agents
RUN_LLM_CWE_SKILL_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=anthropic_strong \
uv run pytest tests/integration/llm/test_cwe_skill.py -q -s
```

By default, deployments are read from `config/model-providers.toml`. If you keep the TOML somewhere else, either set `MODEL_PROVIDERS_CONFIG_TOML` in the command or put it in `agents/.env`.

Memory probes are intentionally split so regressions are easy to isolate:

```bash
cd agents

RUN_LLM_MEMORY_MIDDLEWARE_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=<deployment> \
uv run pytest tests/integration/llm/test_memory_middleware.py -q -s

RUN_LLM_MEMORY_EXTRACTION_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=<deployment> \
uv run pytest tests/integration/llm/test_memory_extraction.py -q -s

RUN_LLM_MEMORY_MAINTENANCE_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=<deployment> \
uv run pytest tests/integration/llm/test_memory_maintenance.py -q -s

RUN_LLM_MEMORY_LIFECYCLE_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=<deployment> \
uv run pytest tests/integration/llm/test_memory_lifecycle.py -q -s
```

## Product Workflow Probes

These use real workflow agents and normal deployment bindings.

| Probe | Enable with | Extra requirements | Purpose |
| --- | --- | --- | --- |
| Issue review narratives | `RUN_LLM_ISSUE_REVIEW_INTEGRATION=1` | issue analyzer binding | Runs the issue analyzer on small synthetic cases. |
| False-positive precedent | `RUN_LLM_FALSE_POSITIVE_PRECEDENT_INTEGRATION=1` | pull-request analyzer binding | Checks precedent-guided false-positive handling. |
| Delivery workbench | `RUN_LLM_DELIVERY_WORKBENCH_INTEGRATION=1` | delivery planning binding | Checks delivery planning workbench use. |
| Discovery skill usage | `RUN_LLM_DISCOVERY_SKILL_INTEGRATION=1` | discovery binding | Checks discovery agent skill usage on inline source. |
| Triage skill usage | `RUN_LLM_TRIAGE_SKILL_INTEGRATION=1` | triage binding | Checks triage agent skill usage on scanner-shaped candidates. |

Example:

```bash
cd agents
RUN_LLM_ISSUE_REVIEW_INTEGRATION=1 \
uv run pytest tests/integration/llm/test_issue_mixed_claims.py -q -s
```

## Heavy Probes

Heavy probes should be run deliberately. They may start Docker containers, run full analyzer workflows, clone public repositories, or retain artifacts for manual inspection.

| Probe | Enable with | Extra requirements | Purpose |
| --- | --- | --- | --- |
| Analyzer Docker + CodeGraph | `RUN_LLM_ANALYZER_CODEGRAPH_DOCKER_INTEGRATION=1` | repository analyzer binding, `sec-review-bot-workspace:codegraph` image | Compares analyzer behavior with and without CodeGraph on a cross-file case. |
| CodeGraph public checkout | `RUN_LLM_CODEGRAPH_REAL_CHECKOUT_INTEGRATION=1` | issue analyzer binding, `sec-review-bot-workspace:codegraph` image, network for clone | Runs a pinned public vulnerable checkout comparison. |
| Language/framework skill contrast | `RUN_LLM_LANGUAGE_FRAMEWORK_SKILL_CONTRAST=1` | issue analyzer binding, Docker | Runs the issue analyzer with and without the language/framework skill. |

Build the CodeGraph workspace image when a probe needs it:

```bash
docker build -f agents/docker/workspace-codegraph.Dockerfile \
  -t sec-review-bot-workspace:codegraph \
  agents
```

Heavy probes usually write artifacts under `.agent-artifacts/`.
