# External Tool Cases

These gated LLM cases verify that a product agent can discover and use an enabled Joern or Playwright CLI through its normal `execute` tool. They do not prove installation or transport; the no-model capability tests under `tests/integration/external_tools/` own those facts.

Each case enables exactly one external-tool prompt, disables skills and MCP, and retains its workspace, transcript, and verifier artifacts under `.agent-artifacts/external-tool-cases/`. Set `EXTERNAL_TOOL_CASE_OUTPUT_DIR` to override the artifact root.

The Playwright capability and discovery cases select `--browser chromium` because the image installs Playwright Chromium while the CLI defaults to an unavailable system Chrome. Joern queries pipe interactive input rather than using `--script /dev/stdin`, which may not terminate because Joern expects a script file. Joern capability tests also print explicit evidence markers because interactive output includes ANSI formatting; the marker is an oracle aid, not an agent workflow requirement.

Run the discovery cases from `agents/`:

```bash
RUN_LLM_EXTERNAL_TOOL_CASES=1 uv run python -m pytest tests/integration/llm/test_external_tool_cases.py -q -s
```
