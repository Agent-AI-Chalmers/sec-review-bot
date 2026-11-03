# Token Usage Summary

Language: English | [中文](README.zh.md)

This directory contains a helper for summarizing token usage and effective patch usage from local run trajectories.

Token accounting follows OpenTelemetry GenAI semantics, while field names belong to the project transcript contract rather than OpenTelemetry attributes or metrics: `input_tokens` and `output_tokens` are inclusive totals. `cache_read_input_tokens` and `cache_creation_input_tokens` are subsets of `input_tokens`, while `reasoning_tokens` is a subset of `output_tokens`. The derived `uncached_input_tokens` subtracts both cache subsets from `input_tokens`.

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

AI turn counts include captured model responses, including summarization and subagents, even when usage metadata is missing. `ai_messages_with_usage_count` separately reports message coverage; a turn without usage is not evidence of zero token consumption.

See the [transcript contract](../../contracts/agent-transcript/v1/SPEC.md) for the transcript format.

## Usage Sources and Completeness

<!-- doc-default: model-call-accounting; source=loading.py -->
`usage_source` identifies the accounting source: `model-calls` for model-call records, `trajectory` for canonical message-only transcripts, and `mixed` for an aggregate of both.

`usage_complete` requires normally completed recording and all six token fields for every observed call. Each aggregate field is independently unknown if any covered call lacks it. Message-only transcripts have limited coverage and are marked incomplete.

`model_call_count` and `model_calls_with_usage_count` show observed calls and responses with usage. AI turns count the captured model responses.

Reports read canonical `message.usage_metadata` directly. The agents runtime owns framework/provider normalization. All six fields use the transcript contract vocabulary, including `cache_read_input_tokens` and `cache_creation_input_tokens`. Unknown aggregate fields are JSON null, empty CSV cells, and `unknown` in text/table output. A field is summed only when every observed call reports it; derived ratios remain unknown when their operands are unknown. `usage_complete` requires completed recording and all six fields for every call.

## Responsibility and Data Flow

This directory is an offline report tool for maintainers, not the runtime token-usage library or an installed package interface. Its entrypoint is `python -m scripts.token_usage.summarize`.

1. `loading.py` discovers stage-local transcripts, excludes published copies, and reads them through the main package's validating transcript reader.
2. Call-end references select the response to count; an unfinished call contributes usage only through an unambiguous recorded response. Historical context is not a new invocation. Message-only transcripts remain readable with limited coverage.
3. `models.py` holds report data and propagates unknown values when aggregating attempts, model groups, and runs.
4. `effective.py` selects actual attempts belonging to the effective patch path. Stage/model aggregates are derived reports and are not converted back into fictitious attempts.
5. `output.py` renders table, text, CSV, or JSON. `summarize.py` supplies the CLI.

The agents runtime owns framework/provider normalization and token-record validation. The transcript contract owns field meanings and call relationships. `scripts/execution_statistics` separately reports calls observed in Langfuse; local artifacts and uploaded observations have different coverage scopes. Neither report proves the other's completeness. Workflow-specific effective-patch selection stays here because it is a local analysis policy, not a token contract.
