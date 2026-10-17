# External Tool Tests

This directory owns the Joern and Playwright CLI tests. Every scenario is a case under `cases/<case-id>/` with a `case.json`; a case may participate in one or more execution modes.

## Modes

### Capability

Capability cases run without an LLM. They prove that the installed CLI, Docker sandbox, workspace materialization, setup declaration, and a specific tool behavior work together. The `case.json` selects a bounded probe and its expected marker; Python owns the probe implementation so fixture data cannot introduce arbitrary commands.

### Discovery

Discovery cases run a product agent against a small local workspace. They test whether the agent notices an enabled external tool, uses it through the normal `execute` interface, and returns the required evidence without receiving a prewritten tool command.

### Compare

Compare cases run the same task twice against identical source: once without the external tool and once with it enabled. Their prompts may name the tool because autonomous selection is already covered by discovery cases.

The OFF arm uses `mcr.microsoft.com/devcontainers/universal:6-noble`. The ON arm uses `sec-review-bot-workspace:tools`. Merely removing the tool prompt would not create a valid baseline because the CLI would remain discoverable in the image. Override these images with `AGENT_EXTERNAL_TOOLS_BASELINE_DOCKER_IMAGE` and `AGENT_EXTERNAL_TOOLS_DOCKER_IMAGE` when necessary.

A compare case requires the ON arm to provide genuine tool-use evidence, but it does not require that arm to outperform the baseline. The summary records result-oracle status, evidence-coverage scores, and the score delta. A neutral or worse ON result is retained as experimental evidence rather than treated as a harness failure.

## Case Layout

A local case contains its checked-in source under `workspace/`. A case that needs a service may also provide `setup.yml`. A compare case may instead declare a public Git repository and a full commit hash; the runner fetches only that pinned revision, removes `.git`, and copies the same source tree into both arms while preserving symlinks.

The mode blocks in `case.json` are deliberately different:

- `capability` selects a deterministic probe, marker, and optional target URL.
- `discovery` defines the product workflow input and behavioral oracle.
- `compare` defines the paired workflow input, behavioral oracle, and comparison evidence patterns.

Shared workspace and setup fields remain at the case level, so one fixture can support multiple modes without duplicating source.

## Isolation And Artifacts

Each enabled LLM arm injects exactly one external-tool prompt. All LLM arms disable skills and MCP.

Workspaces, transcripts, workflow artifacts, and comparison summaries are retained under `.agent-artifacts/external-tool-cases/`. Set `EXTERNAL_TOOL_CASE_OUTPUT_DIR` to use another artifact root. Capability cases use pytest temporary directories because their deterministic assertions do not require post-run transcript analysis.

## Tool Notes

Playwright probes specify `--browser chromium` because the image installs Playwright Chromium while the CLI otherwise looks for an unavailable system Chrome.

Joern queries pipe interactive input instead of using `--script /dev/stdin`, which may not terminate because Joern expects a script file. Capability probes print explicit evidence markers because interactive Joern output contains ANSI formatting; those markers make deterministic assertions stable and are not required in normal agent workflows.

## Running Tests

Run deterministic tests, including no-model capability cases, from `agents/`:

```bash
uv run python -m pytest tests/external_tools -m "not llm"
```

Run only capability cases:

```bash
uv run python -m pytest tests/external_tools -m "integration and not llm"
```

Run all discovery and compare cases:

```bash
RUN_LLM_EXTERNAL_TOOL_CASES=1 uv run python -m pytest tests/external_tools/test_llm_cases.py -q -s
```

Run only the paired comparisons:

```bash
RUN_LLM_EXTERNAL_TOOL_CASES=1 uv run python -m pytest tests/external_tools/test_llm_cases.py -q -s -k comparison
```

## Current Cases

Capability coverage:

- `joern-cross-file-call` checks a CPG cross-file call edge.
- `joern-source-to-sink` checks a CPG data-flow path.
- `playwright-browser-state` checks state persistence across CLI calls.
- `playwright-reflected-xss` checks a browser-observed script side effect.

Discovery coverage:

- `joern-cross-file-call` and `joern-source-to-sink` require independent CPG evidence.
- `playwright-reflected-xss` and `playwright-dom-xss` require browser-observed execution evidence.

Compare coverage:

- `sftpgo-rsync-command` is a neutral control. Its decisive source and sink are concentrated in one production file, so Joern may corroborate the path without improving the conclusion.
- `helm-chart-name-traversal` exercises a broader CPG-shaped task spanning metadata decoding and multiple output boundaries.

Neither compare case is designated a positive Joern result in advance. The retained artifacts determine whether the tool helped a particular run. Playwright currently has discovery coverage but no paired compare case.

## Selection Conclusion

These cases support an engineering choice, not a general effectiveness claim. Joern remains available because its CPG, call-relationship, and data-dependency queries provide a capability that ordinary repository navigation does not. Capability and discovery establish that the installed CLI works and that an agent can use it.

The compare cases have not shown a consistent outcome improvement. In the recorded runs, SFTPGo reached the same evidence coverage with and without Joern, while the Helm Joern arm successfully built and queried a CPG but omitted one item retained by the baseline. These neutral and negative observations show that tool access can add evidence and cost without necessarily improving the final answer.

The project therefore keeps Joern as an opt-in CLI without treating these gated probes as a benchmark of general review quality. Broader statistical evaluation or a deterministic CPG-context pipeline is warranted only if the project later needs to make a stronger claim than capability-based tool selection.
