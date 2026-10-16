"""Cost estimation from OpenRouter prices.

Prices are resolved from the OpenRouter price index (see
``openrouter_pricing``); this module owns the arithmetic. It does not translate
model names: a stage's ``model_id`` is used as-is, and a model the index does not
know is reported as unknown cost.
"""

from .models import CostEstimate, PricingSelection, RunUsage, StageUsage
from .openrouter_pricing import ModelPrice, PriceIndex


def estimate_cost(
    *,
    uncached_input_tokens: int,
    cache_read_tokens: int,
    output_tokens: int,
    input_rate: float | None,
    cache_rate: float | None,
    output_rate: float | None,
) -> float | None:
    """Return the cost for one priced stage, or ``None`` if it cannot be priced.

    A rate may be missing when the source does not model it (for example a model
    without a cache-read price); a missing cache rate is billed at the input
    rate, while a missing input or output rate makes the stage unknown.
    """
    if input_rate is None or output_rate is None:
        return None
    effective_cache_rate = cache_rate if cache_rate is not None else input_rate
    return (
        (uncached_input_tokens / 1_000_000.0) * input_rate
        + (cache_read_tokens / 1_000_000.0) * effective_cache_rate
        + (output_tokens / 1_000_000.0) * output_rate
    )


def collect_used_prices(
    runs: list[RunUsage],
    index: PriceIndex | None,
) -> dict[str, ModelPrice | None]:
    """Map every model id the report looks up to the price used for it.

    ``None`` marks a model the source did not know. The map is ordered by first
    appearance so the report reads in the same order as the runs. This is the
    report's provenance: it records only the handful of models actually used,
    not the whole price table, so the numbers stay explainable from the report
    alone even though no price snapshot is persisted.
    """
    if index is None:
        return {}
    used: dict[str, ModelPrice | None] = {}
    for run in runs:
        for stage in run.stages:
            model_id = stage.model_id
            if model_id not in used:
                used[model_id] = index.lookup(model_id)
    return used


def resolve_pricing_selection(
    index: PriceIndex | None,
    *,
    used_prices: dict[str, ModelPrice | None] | None = None,
) -> PricingSelection:
    """Describe the prices this report was priced against.

    The index is resolved once by the caller (see ``load_price_index``) and
    shared by the report header and the per-stage rows, so the two can never
    disagree. ``index=None`` means no source was available; every stage is then
    reported as unknown cost. The only timestamp kept is ``fetched_at``, the
    instant the live snapshot was taken, which is what a reader needs to judge
    freshness; ``used_prices`` records the models actually looked up.
    """
    if index is None:
        return PricingSelection(fetched_at=None, used_prices=used_prices or {})
    return PricingSelection(
        fetched_at=index.fetched_at,
        used_prices=used_prices or {},
    )


def stage_cost(
    stage: StageUsage,
    index: PriceIndex | None,
) -> tuple[CostEstimate | None, str | None]:
    """Return ``(cost, price_model)`` for one stage.

    ``price_model`` is the model id the price came from, or ``None`` when the
    cost is unknown. Unknown is a first-class result: it means the price source
    did not know the model, not that the cost was zero.
    """
    if index is None:
        return None, None
    price = index.lookup(stage.model_id)
    if price is None:
        return None, None
    amount = estimate_cost(
        uncached_input_tokens=stage.uncached_input_tokens,
        cache_read_tokens=stage.cache_read_tokens,
        output_tokens=stage.output_tokens,
        input_rate=price.input,
        cache_rate=price.cache_read,
        output_rate=price.output,
    )
    if amount is None:
        return None, None
    return CostEstimate(amount=amount, currency=price.currency), stage.model_id


def run_cost(
    run: RunUsage,
    index: PriceIndex | None,
) -> CostEstimate | None:
    """Total cost for a run, or ``None`` if any stage's price is unknown.

    A run is not partially priced: if one stage has no known price, the run
    total is unknown rather than an undercount.
    """
    costs: list[CostEstimate] = []
    for stage in run.stages:
        cost, _ = stage_cost(stage, index)
        if cost is None:
            return None
        costs.append(cost)
    if not costs:
        # A run with no stages has nothing to price; report unknown rather than 0.
        return None
    # Every OpenRouter price is USD, so the stages share one currency label.
    return CostEstimate(
        amount=sum(item.amount for item in costs), currency=costs[0].currency
    )
