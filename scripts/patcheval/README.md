# PatchEval Adapter Scripts

These scripts are benchmark adapters for PatchEval. They intentionally live outside the `sec_review_agents` package so the core runner and workflows do not depend on PatchEval dataset, Docker image, or submission formats.

## Install and Dataset

Install the agents package before running these repository-level scripts:

```bash
cd agents
uv sync --group test
source .venv/bin/activate
cd ..
```

Clone [Agent-AI-Chalmers/PatchEval](https://github.com/Agent-AI-Chalmers/PatchEval.git) in `sec-review-bot` dir.

### Entrypoint

The scripts do not modify `sys.path` to find `agents/src`.
They load `agents/.env` at startup. **Configure `agents/.env` and the referenced `MODEL_PROVIDERS_CONFIG_TOML` before running**; relative paths in `agents/.env` are resolved from the `agents/` directory.

Main entrypoint:

```bash
python -m scripts.patcheval.run_patcheval \
  --cve CVE-2023-41039 \
  --dataset PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json \
  --output-dir .agent-workspace-patcheval
```

The adapter materializes a PatchEval case, converts it into a standard `issue-review` runner request, dispatches the normal runner, and writes the workflow result next to the materialized run.

PatchEval cases specify benchmark Docker images. The adapter enables workspace-image override only for this local evaluation process, so production runner requests still cannot choose arbitrary images. With the default sandbox policy, Docker is used automatically when it is available; otherwise the workflow falls back to host-local execution.

For comparable PatchEval results, run with Docker sandbox execution:

```bash
AGENT_SANDBOX_BACKEND=docker \
python -m scripts.patcheval.run_patcheval \
  --cve CVE-2023-41039 \
  --dataset PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json \
  --output-dir .agent-workspace-patcheval
```

Batch helpers:

- `scripts/patcheval/run-patcheval-six.sh`
- `scripts/patcheval/run-patcheval-experiment-pool.sh`
- `scripts/patcheval/audit-patcheval-workspaces.sh`
- `python -m scripts.patcheval.collect_patcheval_patches`
- `python -m scripts.patcheval.summarize_patcheval_evaluation`

Token usage for current runs is derived from transcript files:

```bash
python -m scripts.token_usage.summarize \
  .agent-workspace-patcheval-CVE-2023-41039-DEEPSEEK-V4-PRO/local-run-*
```

`summarize_patcheval_evaluation` reads the same stage-local transcript artifacts when it fills the token, turn, and price columns in the PatchEval summary.

The full CVE issue evaluation notes, archived `DEEPSEEK-V4-PRO` artifacts, and result analysis are in [evaluation/cve-issue/README.md](../../evaluation/cve-issue/README.md).
