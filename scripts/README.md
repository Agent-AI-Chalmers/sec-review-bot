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
scripts/check_contracts.sh
```

`check_translated_doc_headings.py` scans all tracked `*.zh.md` files, finds the matching English `.md` source, and verifies that heading levels and numbered section markers stay aligned.

`check_contracts.sh` is the aggregate contract validation entrypoint. Keep it aligned with the contract validation surface when adding schema, fixture, parser, or contract-document checks.

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
