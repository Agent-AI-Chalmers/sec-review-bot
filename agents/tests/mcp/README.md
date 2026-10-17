# MCP Tests

This directory owns MCP contract, capability, and LLM behavior tests. Each scenario under `cases/<case-id>/` has a `case.json` and may participate in one or more modes.

## Modes

- `capability` runs without an LLM and proves that a real MCP server and tool work through the Docker backend.
- `discovery` checks whether a product agent selects enabled MCP tools and obtains the required evidence.
- `compare` runs the same product task with MCP disabled and enabled.

Put repository files visible to the agent under `workspace/`, container bootstrap commands in `setup.yml`, and mode-specific inputs and oracles in `case.json`.

The current cases include reflected XSS capability and discovery plus a paired DOM XSS comparison. The DOM case uses a URL fragment, which is not sent to the HTTP server, so runtime browser behavior is the decisive evidence rather than an HTTP response alone. CodeGraph has a deterministic cross-file capability case.

These cases exercise normal product workflows. They do not inject MCP connections or call MCP adapters directly. The runner selects the Docker sandbox, enables MCP, uses the configured tools image, and keeps networking disabled unless a future case establishes a separate requirement.

Keep oracles behavioral: decisive tool interactions, forbidden errors for the capability under test, structured validation level, and result concepts. A required interaction matches one exact tool call's arguments and corresponding result, so browser cases can prove that a payload reached an observable sink effect. Do not pin model prose or a complete tool sequence.

Use `discovery` when the prompt does not name the MCP tool and the case checks whether the product agent selects it. Use `compare` only when paired MCP OFF/ON results answer a useful question; the runner records both results and does not require the OFF run to fail.

Runs retain workspaces, transcripts, and verifier artifacts under `.agent-artifacts/mcp-cases/`, relative to the test process working directory. Set `MCP_CASE_OUTPUT_DIR` to use another location. Each case invocation gets a unique directory; comparison cases keep `without-mcp/` and `with-mcp/` beneath the same run directory for inspection.

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
