# Token Usage Summary

This directory contains the offline helper for summarizing token usage and effective patch cost from local run transcripts.

It is a repository-level reporting script. It reads stage-local transcript files directly.

Install the agents package before running this repository-level script:

```bash
cd agents
uv sync --group test
source .venv/bin/activate
cd ..
```

The script does not modify `sys.path` to find `agents/src`.

## Usage

Summarize one or more local run directories:

```bash
# Default: table
python -m scripts.token_usage.summarize \
  /abs/path/to/local-run-xxx \
  /abs/path/to/local-run-yyy

# Detailed text
python -m scripts.token_usage.summarize --raw /abs/path/to/local-run-xxx

# CSV
python -m scripts.token_usage.summarize --csv /abs/path/to/local-run-xxx

# JSON
python -m scripts.token_usage.summarize --json /abs/path/to/local-run-xxx
```

## Pricing

- By default, the script infers the price profile from each transcript's model
  metadata.
- Use `--price-profile` to force a built-in profile.
- Use `--input-rate`, `--cache-rate`, or `--output-rate` to override rates manually.
- Use `--list-price-profiles` to list built-in price profiles.

## Effective Patch Cost

The default table shows both:

- `TOTAL / all`: total observed usage
- `TOTAL / effective_patch`: usage counted toward the final patch path

`effective_patch` is for comparing workflow shapes. It does not replace total cost accounting.

For 3-stage + feedback:

- without retry: `effective_patch = analyzer.initial + mitigator.initial`
- with retry: `effective_patch = analyzer.initial + all mitigator attempts + verifier attempts except the final verifier`

The default table's `efficiency` is:

```text
effective_patch.total_tokens / total.total_tokens
```
