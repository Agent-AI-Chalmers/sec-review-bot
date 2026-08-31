from .models import CostEstimate, PricingConfig, PricingSelection, RunUsage, StageUsage
from .price_profiles import MODEL_PROFILE_ALIASES, PRICE_PROFILES


def estimate_cost(
    *,
    uncached_input_tokens: int,
    cache_read_tokens: int,
    output_tokens: int,
    input_rate: float | None,
    cache_rate: float | None,
    output_rate: float | None,
) -> float | None:
    if input_rate is None or cache_rate is None or output_rate is None:
        return None
    return (
        (uncached_input_tokens / 1_000_000.0) * input_rate
        + (cache_read_tokens / 1_000_000.0) * cache_rate
        + (output_tokens / 1_000_000.0) * output_rate
    )


def resolve_pricing_selection(config: PricingConfig | None = None) -> PricingSelection:
    config = config or PricingConfig()
    if config.price_profile is not None:
        profile = PRICE_PROFILES.get(config.price_profile)
        input_rate = config.input_rate
        cache_rate = config.cache_rate
        output_rate = config.output_rate
        if profile is not None:
            input_rate = float(profile["input"]) if input_rate is None else input_rate
            cache_rate = float(profile["cache"]) if cache_rate is None else cache_rate
            output_rate = (
                float(profile["output"]) if output_rate is None else output_rate
            )
        return PricingSelection(
            mode="explicit-profile",
            profile=config.price_profile,
            input_rate=input_rate,
            cache_rate=cache_rate,
            output_rate=output_rate,
            currency=(
                str(profile.get("currency")) if isinstance(profile, dict) else None
            ),
        )

    if (
        config.input_rate is not None
        or config.cache_rate is not None
        or config.output_rate is not None
    ):
        return PricingSelection(
            mode="explicit-rates",
            profile=None,
            input_rate=config.input_rate,
            cache_rate=config.cache_rate,
            output_rate=config.output_rate,
            currency=None,
        )

    return PricingSelection(
        mode="auto-profile",
        profile=None,
        input_rate=None,
        cache_rate=None,
        output_rate=None,
        currency=None,
    )


def _resolve_doubao_tier(model_name: str, avg_input_tokens: float) -> str | None:
    if avg_input_tokens <= 32_000:
        suffix = "0-32k"
    elif avg_input_tokens <= 128_000:
        suffix = "32-128k"
    else:
        suffix = "128-256k"
    if model_name in {
        "doubao-seed-2.0-code",
        "doubao-seed-2.0-pro",
        "doubao-seed-2.0-lite",
    }:
        return f"{model_name}-{suffix}"
    return None


def _resolve_mimo_tier(model_name: str, avg_input_tokens: float) -> str | None:
    if model_name != "mimo-v2.5-pro":
        return None
    if avg_input_tokens <= 256_000:
        return "mimo-v2.5-pro-0-256k"
    return "mimo-v2.5-pro-256k-1m"


def model_to_price_profile(stage: StageUsage) -> str | None:
    normalized = str(stage.model_id).strip().lower()
    if not normalized:
        return None
    _, _, model_name = normalized.partition("/")
    candidate = model_name or normalized
    alias = MODEL_PROFILE_ALIASES.get(candidate)
    if alias:
        return alias
    doubao_tier = _resolve_doubao_tier(
        candidate,
        stage.input_tokens / max(stage.ai_messages_with_usage_count, 1),
    )
    if doubao_tier:
        return doubao_tier
    mimo_tier = _resolve_mimo_tier(
        candidate,
        stage.input_tokens / max(stage.ai_messages_with_usage_count, 1),
    )
    if mimo_tier:
        return mimo_tier
    return candidate if candidate in PRICE_PROFILES else None


def estimate_stage_cost(
    stage: StageUsage, pricing: PricingSelection
) -> tuple[CostEstimate | None, str | None]:
    if pricing.mode == "auto-profile":
        profile_name = model_to_price_profile(stage)
        if profile_name is None:
            return None, None
        profile = PRICE_PROFILES[profile_name]
        amount = estimate_cost(
            uncached_input_tokens=stage.uncached_input_tokens,
            cache_read_tokens=stage.cache_read_tokens,
            output_tokens=stage.output_tokens,
            input_rate=float(profile["input"]),
            cache_rate=float(profile["cache"]),
            output_rate=float(profile["output"]),
        )
        currency = str(profile["currency"])
        return (
            (
                CostEstimate(amount=amount, currency=currency)
                if amount is not None
                else None
            ),
            profile_name,
        )

    amount = estimate_cost(
        uncached_input_tokens=stage.uncached_input_tokens,
        cache_read_tokens=stage.cache_read_tokens,
        output_tokens=stage.output_tokens,
        input_rate=pricing.input_rate,
        cache_rate=pricing.cache_rate,
        output_rate=pricing.output_rate,
    )
    if amount is None:
        return None, pricing.profile
    return (
        CostEstimate(amount=amount, currency=pricing.currency or "custom"),
        pricing.profile,
    )


def estimate_run_cost(run: RunUsage, pricing: PricingSelection) -> CostEstimate | None:
    costs: list[CostEstimate] = []
    for stage in run.stages:
        stage_cost, _ = estimate_stage_cost(stage, pricing)
        if stage_cost is None:
            return None
        costs.append(stage_cost)

    currencies = {item.currency for item in costs}
    if len(currencies) != 1:
        return None
    currency = next(iter(currencies))
    return CostEstimate(amount=sum(item.amount for item in costs), currency=currency)
