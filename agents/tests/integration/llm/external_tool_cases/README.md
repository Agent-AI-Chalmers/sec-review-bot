# External Tool Cases

These gated LLM cases verify that a product agent can discover and use an enabled Joern or Playwright CLI through its normal `execute` tool. They do not prove installation or transport; the no-model capability tests under `tests/integration/external_tools/` own those facts.

Discovery cases use small local workspaces with stable oracles. Comparison cases may instead declare a public Git repository and full commit hash. The runner clones that checkout only when the gated probe runs, checks out the pinned revision, removes Git metadata, and then gives identical source copies to the external-tool OFF and ON arms. The OFF arm uses the underlying workspace base image, while the ON arm uses `sec-review-bot-workspace:tools`; disabling only the prompt would be a false baseline because the CLI would remain discoverable in the image. Override the images with `AGENT_EXTERNAL_TOOLS_BASELINE_DOCKER_IMAGE` and `AGENT_EXTERNAL_TOOLS_DOCKER_IMAGE` when needed.

Comparison prompts may name the tool because they measure the result after use; autonomous selection belongs to discovery cases. Each comparison retains both transcripts and a compact summary containing image names, tool-use facts, result-oracle status, evidence-coverage scores, and the score delta. The test requires genuine tool use in the enabled arm but does not require that arm to win: a neutral or worse result is experimental evidence rather than a test-infrastructure failure. Discovery cases retain the strict result oracle.

The SFTPGo rsync case is a neutral control: its decisive source and sink are concentrated in one production file, so Joern may corroborate the path without improving the final conclusion. The Helm chart-name case exercises a broader CPG-shaped task: its result oracle requires the analyzer to connect metadata decoding in the chart loader to both filesystem and tar-path construction in the chart saver. Neither fixture is designated a positive result in advance; the retained comparison artifacts are the evidence for whether a tool improved a particular run.

Each enabled arm injects exactly one external-tool prompt. All arms disable skills and MCP and retain their workspace, transcript, and workflow artifacts under `.agent-artifacts/external-tool-cases/`. Set `EXTERNAL_TOOL_CASE_OUTPUT_DIR` to override the artifact root.

The Playwright capability and discovery cases select `--browser chromium` because the image installs Playwright Chromium while the CLI defaults to an unavailable system Chrome. Joern queries pipe interactive input rather than using `--script /dev/stdin`, which may not terminate because Joern expects a script file. Joern capability tests also print explicit evidence markers because interactive output includes ANSI formatting; the marker is an oracle aid, not an agent workflow requirement.

Run the discovery cases from `agents/`:

```bash
RUN_LLM_EXTERNAL_TOOL_CASES=1 uv run python -m pytest tests/integration/llm/test_external_tool_cases.py -q -s
```

Run only the larger paired checkout comparison with:

```bash
RUN_LLM_EXTERNAL_TOOL_CASES=1 uv run python -m pytest tests/integration/llm/test_external_tool_cases.py -q -s -k comparison
```
