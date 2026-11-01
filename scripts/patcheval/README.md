# PatchEval Adapter Scripts

Language: English | [中文](README.zh.md)

Run agents on PatchEval cases, export patches, and summarize evaluation results. Run the commands below from the repository root.

## Setup

Install dependencies:

```bash
uv sync --project agents --group test
```

Clone [Agent-AI-Chalmers/PatchEval](https://github.com/Agent-AI-Chalmers/PatchEval.git) into `PatchEval/`. Configure `agents/.env` and its `MODEL_PROVIDERS_CONFIG_TOML` for your model provider. Docker must be available to run the benchmark images.

All generation sandboxes run with external networking disabled (`AGENT_DOCKER_NETWORK_MODE=none`), for every variant and component configuration. This is enforced by the PatchEval entrypoints even if the host environment enables networking. Dependencies must already be available in the benchmark image; host-side model API calls remain available.

<!-- doc-default: patcheval.environments; source=PatchEval/patcheval/datasets/environments.json -->
Generation mounts the working copy at the original project path and preserves preinstalled dependencies. Preparation automatically applies the verified per-case PATH and other environment settings from [environments.json](https://github.com/Agent-AI-Chalmers/PatchEval/blob/main/patcheval/datasets/environments.json), and removes top-level evaluation materials from the derived image. Unknown sibling directories stop preparation.

## Run a Single Case

```bash
AGENT_SANDBOX_BACKEND=docker \
uv run --project agents python -m scripts.patcheval.run_patcheval \
  --cve CVE-2023-41039 \
  --dataset PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json \
  --output-dir .agent-workspace-patcheval
```

The command prints the run directory containing the result and logs. For a single CVE managed by the batch runner, use the next command with `--only CVE-ID`.

## Run a Batch

Use `screen` or `tmux` for long runs. Set model and feature settings in that session, then inspect the queue:

```bash
uv run --project agents python -m scripts.patcheval.pool \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default \
  --jobs 4 --timeout-seconds 10800 --max-failures 4 --dry-run
```

Remove `--dry-run` to start. `--jobs` limits concurrent attempts in this pool; `--timeout-seconds` limits each execution, including workspace preparation. `--max-failures` stops new dispatch after the specified number of execution failures and lets in-flight tasks finish; it does not count official evaluation failures.

`--variant` selects a workflow/input variant, not a Skills/Joern/Memory configuration. Repeat it to select multiple variants; omit it to run the full executable matrix. `--tag` names the batch and does not configure its capabilities. Keep the same tag and variant selection when auditing, exporting, and summarizing.

For controlled experiments, add `--freeze-inputs` to fix the inputs and configuration. Start with a new tag and retain the same execution settings when resuming; changed conditions require another tag. Frozen Memory consumption is not supported yet: Memory-enabled runs with a Catalog URL must use ordinary, unfrozen execution.

For default workflows, `--skip-final-verifier` optionally omits verification after the final permitted repair retry. The first verifier still decides whether to retry. Apply the same policy to all conditions being compared.

## Check Progress and Resume

```bash
uv run --project agents python -m scripts.patcheval.audit \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default --summary-only
```

Batch results and logs are under `.agent-workspace-patcheval-<CVE>-<TAG>/`. A completed run means execution produced a patch artifact, not that the official evaluator accepted it.

Repeat the batch command to continue: completed runs, including empty patches, are skipped. Failed or interrupted attempts require explicit retry after checking their logs:

```bash
uv run --project agents python -m scripts.patcheval.pool \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default \
  --only CVE-2023-41039 --resume-incomplete \
  --jobs 1 --timeout-seconds 10800 --max-failures 4 --dry-run
```

Keep the original execution settings, including `--skip-final-verifier` if used. Remove `--dry-run` after checking the retry selection. After a host crash or forced termination, inspect unfinished tasks and leftover containers before resuming.

## Export Patches and Summarize Results

Export patches for the selected variant:

```bash
uv run --project agents python -m scripts.patcheval.collect_patcheval_patches \
  --tag PATCHEVAL-RUN-01 --variant end-to-end-default --fill-from-dataset
```

Unfinished tasks are rejected by default. If the experiment protocol calls for empty submissions for these tasks, explicitly add `--incomplete empty`. Other submission policies are described by `--help`.

Evaluate the exported patches with the official PatchEval evaluator; see the [evaluation guide](../../evaluation/cve-issue/README.md). Then summarize its results:

```bash
uv run --project agents python -m scripts.patcheval.summarize_patcheval_evaluation \
  --tag PATCHEVAL-RUN-01 --prefix PATCHEVAL-RUN-01 \
  --variant end-to-end-default
```

Set `--prefix` to the evaluator's actual output prefix. Use `--patch-input-dir` if the exported patches are in a different directory.

To summarize token usage and cost for local runs:

```bash
uv run --project agents python -m scripts.token_usage.summarize \
  .agent-workspace-patcheval-CVE-2023-41039-PATCHEVAL-RUN-01/local-run-*
```

PatchEval summaries use `effective_patch` cost, which excludes the final verifier that does not change the patch; prices are reference estimates, not actual bills. See [token usage and cost](../token_usage/README.md) for details. Each command also provides `--help`.
