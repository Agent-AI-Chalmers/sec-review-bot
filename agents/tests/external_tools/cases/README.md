# External Tool Cases

These gated LLM cases test whether product agents can use an enabled Joern or Playwright CLI through their normal `execute` tool. Installation and basic CLI behavior belong to the no-model capability tests next to this package under `tests/external_tools/`.

## Test Levels

### Discovery

Discovery cases use small local workspaces and strict result oracles. They test whether an agent notices the enabled tool, uses it without a tool-specific task instruction, and produces the required evidence.

### Comparison

Comparison cases run the same task twice against identical source: once without the external tool and once with it enabled. Their prompts may name the tool because autonomous selection is already covered by discovery cases.

The OFF arm uses `mcr.microsoft.com/devcontainers/universal:6-noble`. The ON arm uses `sec-review-bot-workspace:tools`. Merely removing the tool prompt would not create a valid baseline because the CLI would remain discoverable in the image. Override these images with `AGENT_EXTERNAL_TOOLS_BASELINE_DOCKER_IMAGE` and `AGENT_EXTERNAL_TOOLS_DOCKER_IMAGE` when necessary.

A comparison test requires the ON arm to provide genuine tool-use evidence, but it does not require that arm to outperform the baseline. The summary records result-oracle status, evidence-coverage scores, and the score delta. A neutral or worse ON result is retained as experimental evidence rather than treated as a harness failure.

## Comparison Checkouts

A comparison fixture may declare a public Git repository and a full commit hash. The runner fetches only that pinned revision, removes `.git`, and copies the resulting source tree into each arm while preserving symlinks. Both agents therefore receive the same repository state without commit history.

## Isolation And Artifacts

Each enabled arm injects exactly one external-tool prompt. All arms disable skills and MCP.

Workspaces, transcripts, workflow artifacts, and comparison summaries are retained under `.agent-artifacts/external-tool-cases/`. Set `EXTERNAL_TOOL_CASE_OUTPUT_DIR` to use another artifact root.

## Tool Notes

Playwright cases specify `--browser chromium` because the image installs Playwright Chromium while the CLI otherwise looks for an unavailable system Chrome.

Joern queries pipe interactive input instead of using `--script /dev/stdin`, which may not terminate because Joern expects a script file. Capability tests print explicit evidence markers because interactive Joern output contains ANSI formatting; those markers support stable test assertions and are not required in normal agent workflows.

## Running Cases

Run all discovery and comparison cases from `agents/`:

```bash
RUN_LLM_EXTERNAL_TOOL_CASES=1 uv run python -m pytest tests/external_tools/test_llm_cases.py -q -s
```

Run only the larger paired comparisons:

```bash
RUN_LLM_EXTERNAL_TOOL_CASES=1 uv run python -m pytest tests/external_tools/test_llm_cases.py -q -s -k comparison
```

## Current Fixtures

Discovery cases:

- `joern-source-to-sink` requires Joern evidence for a local source-to-sink flow.
- `joern-cross-file-call` requires Joern evidence across a caller and callee.
- `playwright-reflected-xss` requires browser-observed reflected XSS execution.
- `playwright-dom-xss` requires browser-observed DOM XSS execution.

Comparison cases:

- `sftpgo-rsync-command` is a neutral control. Its decisive source and sink are concentrated in one production file, so Joern may corroborate the path without improving the conclusion.
- `helm-chart-name-traversal` exercises a broader CPG-shaped task. Its result oracle covers metadata decoding in the chart loader and both filesystem and tar-path construction in the chart saver.

Neither comparison fixture is designated a positive Joern result in advance. The retained artifacts determine whether the tool helped a particular run. Playwright currently has discovery coverage but no paired comparison fixture.

## Selection Conclusion

These cases support an engineering choice, not a general effectiveness claim. Joern remains available because its CPG, call-relationship, and data-dependency queries provide a capability that ordinary repository navigation does not. The capability and discovery cases establish that the installed CLI works and that an agent can use it.

The comparison cases have not shown a consistent outcome improvement. In the recorded runs, SFTPGo reached the same evidence coverage with and without Joern, while the Helm Joern arm successfully built and queried a CPG but omitted one item retained by the baseline. These are useful neutral and negative observations: they show that tool access can add evidence and cost without necessarily improving the final answer.

The project therefore keeps Joern as an opt-in CLI without treating these gated probes as a benchmark of general review quality. Broader statistical evaluation or a deterministic CPG-context pipeline is warranted only if the project later needs to make a stronger claim than capability-based tool selection.
