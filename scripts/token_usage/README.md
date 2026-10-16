# Token Usage Summary

This directory contains a helper for summarizing token usage and effective patch cost from local run transcripts.

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

The input may be a run wrapper containing `artifacts/`, or an artifact root written directly by the integrated deployment, such as `.agent-artifacts/run-20260926T144116Z-348e955e`.

## Pricing

Prices come from OpenRouter's public model list. Each stage's `model_id` is looked up as-is: a full `<provider>/<model>` id must match exactly, while a bare `<model>` is resolved by its leaf only when the source has exactly one entry with that leaf. A model the source does not know, or a bare name whose leaf is shared by two providers, is reported as **unknown cost**, never guessed.

- Prices are fetched live on every run; nothing is cached on disk. A report therefore never depends on what any machine happened to fetch earlier.
- The report header shows `fetched_at`, the UTC instant of the live snapshot. That is the only timestamp; there is no per-run generation date, so the report contents depend only on the inputs and the fetched prices.
- The JSON output records `pricing.used_prices`: the prices actually used for the handful of models in the report (`null` for a model the source did not know). This keeps the cost figures explainable from the report alone, without persisting the whole price table.

Model-name mapping is the caller's responsibility, not this script's: the `model_id` recorded in a transcript must name a model the price source knows. An unmapped model is reported as unknown rather than silently mispriced.

The source is a single live endpoint with no history, so a past price cannot be requested later; a report can only be priced at fetch time or left unknown.

OpenRouter is a reseller index, so its prices may differ from the model provider's official prices; treat the cost here as a reference estimate, not the actual bill. When the source publishes no cache-read price for a model, cached input is billed at the model's uncached input rate rather than treated as free; a model whose input or output price is missing is reported as unknown cost.

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
