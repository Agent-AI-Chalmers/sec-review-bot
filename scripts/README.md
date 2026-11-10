# Repository Scripts

Language: English | [中文](README.zh.md)

This directory contains repository-level helper scripts. They are not part of the `sec_review_agents` package, and Python scripts here do not modify `sys.path` to find `agents/src`.

> [!NOTE]
> These scripts are convenience tools for repository maintainers. They are not a stable public interface and may follow internal code, local environment, and workflow changes without compatibility shims. Use the ones that help; ignore the ones that do not. If a script breaks, prefer updating or deleting it over preserving old behavior as a contract.

## Directory Layout

- `checks/`: repository-wide documentation checks and shared helpers.
- `dev/`: local development process launchers.
- `ops/`: maintenance, scheduling, and operational inspection scripts.
- `experiments/`: model and memory extraction probes.
- `replay/`: workflow and stage replay helpers.
- `execution_statistics/` and `tests/`: statistics helpers and repository script tests, respectively.

Repository-wide checks live in `checks/` and run as modules from the repository root.

## Check Entrypoints

Check scripts are intended to be repeatable from the repository root:

```bash
# Check local Markdown links.
python -m scripts.checks.markdown_links

# Check prose for hard wrapping.
python -m scripts.checks.markdown_wrapping

# Check translated heading structure.
python -m scripts.checks.translated_doc_headings
```

`translated_doc_headings.py` scans all tracked `*.zh.md` files, finds the matching English `.md` source, and verifies that heading levels and numbered section markers stay aligned.

## Local Helpers

Install or activate the agents environment before running scripts that depend on the agents project:

```bash
cd agents
uv sync --group test
cd ..
```

Then run module-style helpers from the repository root:

```bash
# from the repository root, sec-review-bot
source agents/.venv/bin/activate
python -m scripts.replay.repository_triage --help
```

## System Test

See [Cross-service System Tests](../system-tests/README.md) for the submission test, model-free smoke probes, and manual execution lifecycle probe, including prerequisites, commands, coverage limits, isolation, and CI cost controls.

### Langfuse Run Statistics Probe

`ops/probe_langfuse_run_statistics.py` reads one review `run_id` from the [Langfuse Observations API v2](https://langfuse.com/docs/api-and-data-platform/features/public-api#v2) and prints a read-only JSON summary. It finds roots whose `sec_review_agent` belongs to the maintained review-agent allowlist, reads `GENERATION` observations under those traces with cursor pagination, and accepts only calls emitted by the Langfuse callback scope. Provider-SDK duplicate spans are suppressed by the production exporter; encountering one here is treated as a tracing regression. Remaining calls are deduplicated by observation ID and grouped by agent and native provider/model.

Run it with the agents environment so the repository's pinned Langfuse SDK is used:

```bash
LANGFUSE_PUBLIC_KEY=... \
LANGFUSE_SECRET_KEY=... \
LANGFUSE_BASE_URL=https://your-langfuse.example \
uv --project agents run python -m scripts.ops.probe_langfuse_run_statistics <run_id>
```

The output describes calls observed by Langfuse. `complete_for_observed_calls` means every returned generation had usage; it does not prove that every call was uploaded.

## Experimental Memory Probe

- `experiments/memory_extract_observations.py` runs the memory extractor against specified trajectory files or review artifact directories, producing observations and an extractor trajectory.
- `experiments/memory_maintain.py` calls the package memory maintainer directly to build or update a local memory tree from observations.

Both scripts read and write local files without Temporal, Memory Catalog, PostgreSQL, or object storage.

```bash
# Build a new Memory tree from observation Markdown files.
uv --project agents run python -m scripts.experiments.memory_maintain \
  observations/*.md --output-dir runs/memory-01

# Absorb another batch into a copy of the previous tree.
uv --project agents run python -m scripts.experiments.memory_maintain \
  observations-next/*.md --base-memory runs/memory-01/memory \
  --output-dir runs/memory-02
```

Inputs are processed in argument order; filename stems identify observations and must be unique. `--deployment` optionally overrides the maintainer model deployment. The output directory must not exist. It contains `memory/`, a maintainer trajectory, and `manifest.json` with input hashes, base-tree fingerprints, the deployment override, timestamps, execution status, and successful output fingerprints. Input files and the base tree are not modified. Staged observations are removed from a successful Memory output; a failed attempt keeps its partial files and records failure. Retry into a new directory. Learning requires at least one observation; reorganization requires `--base-memory` and accepts no observations; no automatic batching or retry is performed.

## Local Development Workers

From the repository root, start the Execution, Memory Extraction, and Memory Maintenance workers together:

```bash
uv --project agents run python -m scripts.dev.dev_workers --env-file compose.memory.env
```

The former `sec-review-agents-memory dev-workers` subcommand is removed; use the command above instead.

This development launcher maps role-specific storage credentials and stops the worker group when a worker exits or it receives SIGINT/SIGTERM. It requires the infrastructure described in [local Memory setup](../docs/operations/LOCAL_MEMORY_DEVELOPMENT.md); it does not start Compose services.

## Memory Operations

Run these commands from the repository root with the agents project environment:

```bash
uv --project agents run python -m scripts.ops.memory_ops --env-file compose.memory.env maintain
uv --project agents run python -m scripts.ops.memory_ops --env-file compose.memory.env maintain --mode reorganization
uv --project agents run python -m scripts.ops.memory_ops --env-file compose.memory.env schedules maintenance ensure
```

<!-- doc-default: memory-maintenance-mode; source=scripts/ops/memory_ops.py -->
`maintain` starts a maintenance workflow in Temporal. The default `--mode learning` consumes pending observations; `--mode reorganization` reorganizes the active memory without consuming observations and is manually triggered. `schedules maintenance ensure` creates or updates the periodic learning trigger. Both require the configured Temporal service; actual maintenance also requires the worker, Memory Catalog, and object storage. Use each subcommand's `--help` to inspect connection, timeout, batch, and schedule options.
