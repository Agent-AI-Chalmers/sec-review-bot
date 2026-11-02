# Token Usage Summary

Language: English | [中文](README.zh.md)

This directory contains a helper for summarizing token usage and effective patch usage from local run trajectories.

Token fields follow OpenTelemetry GenAI semantics: `input_tokens` and `output_tokens` are inclusive totals. `cache_read_tokens` and `cache_creation_tokens` are subsets of `input_tokens`, while `reasoning_tokens` is a subset of `output_tokens`. The derived `uncached_input_tokens` subtracts both cache subsets from `input_tokens`.

It is a repository-level reporting script. It reads stage-local trajectory files directly.

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

The input may be a run wrapper containing `artifacts/`, or an artifact root written directly by the integrated deployment, such as `.agent-artifacts/run-20260926T144116Z-348e955e`.

## No cost estimation

This report counts observed tokens only. Pricing them is deliberately left to a human: a price is meaningful only with the billing context of the account that paid — provider or reseller, contract discounts, batch or off-peak rates, cache read and write rules, context-tier thresholds, credits, currency, and the date of the price list. No automated figure can know those, so the report emits none. There is no opt-in flag: adding one would recreate the same false precision.

Anyone who needs a money figure must do the conversion by hand against an explicit, pinned price table, and record at least:

- the price source and its date;
- how each `model_id` maps to a price entry;
- the input, output, cache-read and cache-write rates used;
- the tier, cache and discount assumptions;
- what was excluded.

Treat the result as an analysis with stated assumptions, not as a field of this report. Do not compare providers by token count alone.

## Effective Patch Usage

The default table shows both:

- `TOTAL / all`: total observed usage
- `TOTAL / effective_patch`: usage counted toward the final patch path

`effective_patch` is for comparing workflow shapes. It does not replace total usage accounting.

For 3-stage + feedback:

- without retry: `effective_patch = analyzer.initial + mitigator.initial`
- with retry: `effective_patch = analyzer.initial + all mitigator attempts + verifier attempts except the final verifier`

The default table's `efficiency` is:

```text
effective_patch.total_tokens / total.total_tokens
```

AI turn counts include assistant messages even when usage metadata is missing. `ai_messages_with_usage_count` separately reports coverage; a turn without usage is not evidence of zero token consumption.
