# MCP LLM Cases

Each directory under `fixtures/` is one end-to-end MCP case. Put the repository files visible to the agent under `workspace/`, the container bootstrap commands in `setup.yml`, and the review input plus observable oracles in `case.json`.

The current fixtures include reflected XSS discovery and a paired DOM XSS comparison. The DOM case uses a URL fragment, which is not sent to the HTTP server, so runtime browser behavior is the decisive evidence rather than an HTTP response alone.

These cases exercise normal product workflows. They do not inject MCP connections or call MCP adapters directly. The runner selects the Docker sandbox, enables MCP, uses the configured tools image, and keeps networking disabled unless a future case establishes a separate requirement.

Keep oracles behavioral: decisive tool interactions, forbidden errors for the capability under test, structured validation level, and result concepts. A required interaction matches one exact tool call's arguments and corresponding result, so browser cases can prove that a payload reached an observable sink effect. Do not pin model prose or a complete tool sequence.

Use `discovery` when the prompt does not name the MCP tool and the case checks whether the product agent selects it. Use `compare` only when paired MCP OFF/ON results answer a useful question; the runner records both results and does not require the OFF run to fail.

Runs retain workspaces, transcripts, and verifier artifacts under `.agent-artifacts/mcp-cases/`, relative to the test process working directory. Set `MCP_CASE_OUTPUT_DIR` to use another location. Each case invocation gets a unique directory; comparison cases keep `without-mcp/` and `with-mcp/` beneath the same run directory for inspection.

MCP transport and tool behavior are covered separately without a model under `tests/integration/mcp/`. Playwright capability tests cover browser startup and state continuity; the CodeGraph capability test covers real index preparation and cross-file exploration. Keep infrastructure assertions there rather than making an LLM case diagnose MCP runtime failures.

Run deterministic fixture validation with:

```bash
uv run pytest -q tests/mcp/test_mcp_case_fixtures.py
```

Run the real-model integration cases after building the tools image:

```bash
RUN_LLM_MCP_CASES=1 \
uv run pytest -q -s tests/integration/llm/test_mcp_cases.py
```

Cases are pytest parameters whose IDs match their fixture directory names. Select one case or one mode without adding another environment-variable namespace:

```bash
RUN_LLM_MCP_CASES=1 \
uv run pytest -q -s tests/integration/llm/test_mcp_cases.py \
  -k 'discovery and playwright-reflected-xss'
```

This is the same selection model used by bundled skill cases: one probe gate enables the suite, while pytest node IDs and `-k` choose the specific case.

Run the no-model capability integration with:

```bash
uv run pytest -q -s tests/integration/mcp/test_playwright_capability.py
```
