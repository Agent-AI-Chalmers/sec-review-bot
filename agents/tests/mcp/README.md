# MCP Tests

This directory owns MCP contract, capability, and LLM behavior tests. Each scenario under `cases/<case-id>/` has a `case.json` and may participate in one or more modes.

## Modes

- `capability` runs without an LLM and proves that a real MCP server and tool work through the Docker backend.
- `discovery` checks whether a product agent selects enabled MCP tools and obtains the required evidence.
- `compare` runs the same product task with MCP disabled and enabled.

Put repository files visible to the agent under `workspace/`, container bootstrap commands in `setup.yml`, and mode-specific inputs and oracles in `case.json`.

The current cases include reflected XSS capability and discovery plus a paired DOM XSS comparison. The DOM case uses a URL fragment, which is not sent to the HTTP server, so the decisive evidence comes from runtime browser behavior; an HTTP response alone cannot show it. CodeGraph has a deterministic cross-file capability case.

These cases exercise normal product workflows. They do not inject MCP connections or call MCP adapters directly. The runner selects the Docker sandbox, enables MCP, uses the configured tools image, and keeps networking disabled unless a future case establishes a separate requirement.

Keep oracles behavioral: decisive tool interactions, forbidden errors for the capability under test, structured validation level, and result concepts. A required interaction matches one exact tool call's arguments and corresponding result, so browser cases can prove that a payload reached an observable sink effect. Do not pin model prose or a complete tool sequence.

Use `discovery` when the prompt does not name the MCP tool and the case checks whether the product agent selects it. Use `compare` only when paired MCP OFF/ON results answer a useful question; the runner records both results and does not require the OFF run to fail.

Runs retain workspaces, trajectories, and verifier artifacts under `.agent-artifacts/mcp-cases/`, relative to the test process working directory. Set `MCP_CASE_OUTPUT_DIR` to use another location. Each case invocation gets a unique directory; comparison cases keep `without-mcp/` and `with-mcp/` beneath the same run directory for inspection.

MCP contract tests mock connection construction. `test_capability.py` covers Playwright browser startup and browser-observed effects plus CodeGraph index preparation and cross-file exploration. Keep infrastructure assertions there rather than making an LLM case diagnose MCP runtime failures.

Run deterministic fixture validation with:

```bash
uv run python -m pytest -q tests/mcp/test_case_fixtures.py
```

Run the real-model integration cases after building the tools image:

```bash
RUN_LLM_MCP_CASES=1 \
uv run python -m pytest -q -s tests/mcp/test_llm.py
```

Cases are pytest parameters whose IDs match their fixture directory names. Select one case or one mode without adding another environment-variable namespace:

```bash
RUN_LLM_MCP_CASES=1 \
uv run python -m pytest -q -s tests/mcp/test_llm.py \
  -k 'discovery and playwright-reflected-xss'
```

This is the same selection model used by bundled skill cases: one probe gate enables the suite, while pytest node IDs and `-k` choose the specific case.

The workspace tools image is intentionally not built by standard CI because it is a large development image. Build it explicitly before running this developer-provisioned integration check; the ordinary suite skips the capability cases when the image is absent.

Run the no-model capability integration with:

```bash
docker image inspect sec-review-bot-workspace:tools >/dev/null
uv run python -m pytest -q -s tests/mcp/test_capability.py
```

## CodeGraph Comparisons

The standalone comparison probes exercise explicitly requested tool evidence, not autonomous discovery. Model setup is documented in [PROBES.md](../PROBES.md).

```bash
RUN_LLM_ANALYZER_CODEGRAPH_DOCKER_INTEGRATION=1 \
uv run python -m pytest tests/mcp/test_llm_analyzer_codegraph.py -q -s

RUN_LLM_CODEGRAPH_REAL_CHECKOUT_INTEGRATION=1 \
uv run python -m pytest tests/mcp/test_llm_codegraph_real_checkout.py -q -s
```

The synthetic cross-file case uses the repository analyzer binding; the pinned public checkout uses the issue analyzer binding. Both need the tools image. The public checkout also needs Git network access. Tests isolate global Git configuration; supply `HTTP_PROXY` and `HTTPS_PROXY` in the process environment when a proxy is needed.

Comparisons require a successful non-empty tool reply in the explicitly instructed ON arm and no CodeGraph calls in the OFF arm. Verdicts, known-file mentions and result concepts are observations retained for inspection, not pass criteria or evidence that CodeGraph improves detection.

The synthetic probe retains trajectories under pytest's temporary directory. Public checkout runs retain their workspace, trajectories and summary under `.agent-artifacts/codegraph-real-checkout/`; override this with `CODEGRAPH_REAL_CHECKOUT_OUTPUT_DIR`.

<!-- doc-default: codegraph-real-checkout-budget; source=agents/tests/mcp/test_llm_codegraph_real_checkout.py -->

The public-checkout probe allows 300 graph steps per arm and a 900-second test timeout.
