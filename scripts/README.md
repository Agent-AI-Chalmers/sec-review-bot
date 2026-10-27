# Repository Scripts

This directory contains repository-level helper scripts. They are not part of the `sec_review_agents` package, and Python scripts here do not modify `sys.path` to find `agents/src`.

> [!NOTE]
> These scripts are convenience tools for repository maintainers. They are not a stable public interface and may follow internal code, local environment, and workflow changes without compatibility shims. Use the ones that help; ignore the ones that do not. If a script breaks, prefer updating or deleting it over preserving old behavior as a contract.

## Check Entrypoints

Check scripts are intended to be repeatable from the repository root:

```bash
python scripts/check_markdown_links.py
python scripts/check_markdown_wrapping.py
python scripts/check_translated_doc_headings.py
```

`check_translated_doc_headings.py` scans all tracked `*.zh.md` files, finds the matching English `.md` source, and verifies that heading levels and numbered section markers stay aligned.

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
python -m scripts.token_usage.summarize /path/to/local-run
python -m scripts.replay.repository_triage --help
```

### Langfuse Run Statistics Probe

`probe_langfuse_run_statistics.py` reads one review `run_id` from the [Langfuse Observations API v2](https://langfuse.com/docs/api-and-data-platform/features/public-api#v2) and prints a read-only JSON summary. It finds roots whose `sec_review_agent` belongs to the maintained review-agent allowlist, reads `GENERATION` observations under those traces with cursor pagination, and keeps the LangChain calls carrying native `ls_provider` metadata. Provider-SDK auto-instrumentation observations are reported as excluded instead of double-counted. Remaining calls are deduplicated by observation ID and grouped by agent and native provider/model.

Run it with the agents environment so the repository's pinned Langfuse SDK is used:

```bash
LANGFUSE_PUBLIC_KEY=... \
LANGFUSE_SECRET_KEY=... \
LANGFUSE_BASE_URL=https://your-langfuse.example \
uv --project agents run python -m scripts.probe_langfuse_run_statistics <run_id>
```

The output describes calls observed by Langfuse. `complete_for_observed_calls` means every returned generation had usage; it does not prove that every call was uploaded.

## Experimental Memory Probe

`experimental_memory_extract_observations.py` runs the memory extractor against explicit transcript files or review artifact directories and writes the observation preview and a uniquely named extractor transcript to a requested directory. It is a model-development probe, not an operational ingestion path: it does not use Temporal, register state with the Memory Catalog, or publish artifacts.

There is no repository script for directly maintaining persistent memory from observation files. Operational maintenance is started and scheduled through the agents Temporal CLI; persistent state remains owned by the Memory Catalog.
