import csv
import io
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import (
    AttemptUsage,
    CostEstimate,
    EffectivePatchUsage,
    PricingConfig,
    PricingSelection,
    RunUsage,
    UsageTotals,
    aggregate_stage_usages,
    compute_effective_patch_usage,
    effective_patch_efficiency,
    effective_patch_run,
    estimate_run_cost,
    estimate_stage_cost,
    resolve_pricing_selection,
)
from .price_profiles import (
    DEFAULT_PRICE_PROFILE,
    PRICE_PROFILES,
)


@dataclass(frozen=True)
class RenderConfig:
    pricing: PricingConfig = field(default_factory=PricingConfig)


def should_render_attempt_rows(run: RunUsage) -> bool:
    return run.workflow_kind not in {
        "issue-review-two-stage-workflow-result",
        "issue-review-single-agent-workflow-result",
        "repository-review-workflow-result",
    }


def displayable_effective_attempts(
    run: RunUsage, effective: EffectivePatchUsage
) -> list[AttemptUsage]:
    if not should_render_attempt_rows(run):
        return []
    return [item for item in effective.included_attempts if item.stage != "analyzer"]


def displayable_attempt_rows(run: RunUsage) -> list[AttemptUsage]:
    if not should_render_attempt_rows(run):
        return []
    return [item for item in run.attempts if item.stage != "analyzer"]


def display_run_name(run: RunUsage) -> str:
    return run.experiment or Path(run.run_dir).name


def render_price_profiles() -> str:
    lines = [f"default_price_profile={DEFAULT_PRICE_PROFILE}", ""]
    for name, rates in sorted(PRICE_PROFILES.items()):
        lines.append(
            f"{name}: input={rates['input']} cache={rates['cache']} output={rates['output']} {rates['currency']}/1M"
        )
    return "\n".join(lines) + "\n"


def render_pricing_header(pricing: PricingSelection) -> list[str]:
    if pricing.mode == "auto-profile":
        return ["pricing: profile=auto-by-model_id", ""]
    if (
        pricing.input_rate is not None
        and pricing.cache_rate is not None
        and pricing.output_rate is not None
    ):
        return [
            (
                "pricing: "
                f"profile={pricing.profile or 'custom'} "
                f"input={pricing.input_rate} "
                f"cache={pricing.cache_rate} "
                f"output={pricing.output_rate} "
                f"{pricing.currency or 'custom'}/1M"
            ),
            "",
        ]
    return []


def table_row(columns: list[str], widths: list[int]) -> str:
    return "  ".join(
        value.ljust(width) for value, width in zip(columns, widths, strict=False)
    ).rstrip()


def render_rows(
    header: list[str], rows: list[list[str]], *, prefix_lines: list[str] | None = None
) -> str:
    widths = [
        (
            max(len(header[idx]), *(len(row[idx]) for row in rows))
            if rows
            else len(header[idx])
        )
        for idx in range(len(header))
    ]
    lines = list(prefix_lines or [])
    lines.append(table_row(header, widths))
    lines.append(table_row(["-" * width for width in widths], widths))
    for row in rows:
        lines.append(table_row(row, widths))
    return "\n".join(lines).rstrip() + "\n"


def format_cost(cost: CostEstimate | None) -> str:
    return f"{cost.amount:.6f} {cost.currency}" if cost is not None else ""


def render_raw_text(runs: list[RunUsage], config: RenderConfig | None = None) -> str:
    config = config or RenderConfig()
    pricing = resolve_pricing_selection(config.pricing)
    lines: list[str] = render_pricing_header(pricing)

    for run in runs:
        effective = compute_effective_patch_usage(run)
        totals = effective.totals
        run_cost = estimate_run_cost(run, pricing)
        effective_cost = estimate_run_cost(effective_patch_run(run), pricing)
        visible_attempts = displayable_effective_attempts(run, effective)

        lines.append(run.run_dir)
        lines.append(
            "  total: "
            f"input={run.input_tokens:,} "
            f"output={run.output_tokens:,} "
            f"total={run.total_tokens:,} "
            f"cache_read={run.cache_read_tokens:,} "
            f"uncached_input={run.uncached_input_tokens:,} "
            f"cache_ratio={run.cache_ratio * 100:.2f}% "
            f"ai_msgs={run.ai_message_count}"
        )
        if run_cost is not None:
            lines.append(f"  estimated_cost={run_cost.amount:.6f} {run_cost.currency}")

        lines.append(
            "  effective_patch: "
            f"input={totals.input_tokens:,} "
            f"output={totals.output_tokens:,} "
            f"total={totals.total_tokens:,} "
            f"cache_read={totals.cache_read_tokens:,} "
            f"uncached_input={totals.uncached_input_tokens:,} "
            f"cache_ratio={totals.cache_ratio * 100:.2f}% "
            f"ai_msgs={totals.ai_message_count}"
        )
        if effective_cost is not None:
            lines.append(
                f"  effective_patch_cost={effective_cost.amount:.6f} {effective_cost.currency}"
            )
        if visible_attempts:
            labels = ", ".join(
                f"{item.stage}.{item.attempt_label}" for item in visible_attempts
            )
            lines.append(f"  effective_patch_attempts={labels}")

        for stage in run.stages:
            stage_cost, inferred_profile = estimate_stage_cost(stage, pricing)
            line = (
                "  - "
                f"{stage.stage}: "
                f"model_id={stage.model_id} "
                f"profile={inferred_profile or 'unknown'} "
                f"input={stage.input_tokens:,} "
                f"output={stage.output_tokens:,} "
                f"total={stage.total_tokens:,} "
                f"cache_read={stage.cache_read_tokens:,} "
                f"uncached_input={stage.uncached_input_tokens:,} "
                f"cache_ratio={stage.cache_ratio * 100:.2f}% "
                f"ai_msgs={stage.ai_message_count}"
            )
            if stage_cost is not None:
                line += f" estimated_cost={stage_cost.amount:.6f} {stage_cost.currency}"
            lines.append(line)
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_table(runs: list[RunUsage], config: RenderConfig | None = None) -> str:
    config = config or RenderConfig()
    pricing = resolve_pricing_selection(config.pricing)
    header = [
        "run",
        "stage",
        "scope",
        "model",
        "profile",
        "input",
        "output",
        "cache_read",
        "uncached",
        "cache_ratio",
        "efficiency",
        "ai_msgs",
        "cost",
    ]
    rows: list[list[str]] = []

    for run in runs:
        run_cost = estimate_run_cost(run, pricing)
        effective = compute_effective_patch_usage(run)
        effective_totals = effective.totals
        effective_cost = estimate_run_cost(effective_patch_run(run), pricing)
        efficiency = effective_patch_efficiency(run)

        rows.append(
            [
                display_run_name(run),
                "TOTAL",
                "all",
                "-",
                pricing.profile
                or ("auto" if pricing.mode == "auto-profile" else "custom"),
                f"{run.input_tokens:,}",
                f"{run.output_tokens:,}",
                f"{run.cache_read_tokens:,}",
                f"{run.uncached_input_tokens:,}",
                f"{run.cache_ratio * 100:.2f}%",
                f"{efficiency * 100:.2f}%",
                str(run.ai_message_count),
                format_cost(run_cost),
            ]
        )
        rows.append(
            [
                "",
                "TOTAL",
                "effective_patch",
                "-",
                pricing.profile
                or ("auto" if pricing.mode == "auto-profile" else "custom"),
                f"{effective_totals.input_tokens:,}",
                f"{effective_totals.output_tokens:,}",
                f"{effective_totals.cache_read_tokens:,}",
                f"{effective_totals.uncached_input_tokens:,}",
                f"{effective_totals.cache_ratio * 100:.2f}%",
                f"{efficiency * 100:.2f}%",
                str(effective_totals.ai_message_count),
                format_cost(effective_cost),
            ]
        )

        for stage in run.stages:
            stage_cost, inferred_profile = estimate_stage_cost(stage, pricing)
            rows.append(
                [
                    "",
                    stage.stage,
                    "all",
                    stage.model_id,
                    inferred_profile or "unknown",
                    f"{stage.input_tokens:,}",
                    f"{stage.output_tokens:,}",
                    f"{stage.cache_read_tokens:,}",
                    f"{stage.uncached_input_tokens:,}",
                    f"{stage.cache_ratio * 100:.2f}%",
                    "",
                    str(stage.ai_message_count),
                    format_cost(stage_cost),
                ]
            )

        displayed_attempt_rows = displayable_attempt_rows(run)
        if displayed_attempt_rows:
            visible_attempts = displayable_effective_attempts(run, effective)
            for attempt in displayed_attempt_rows:
                stage_cost, inferred_profile = estimate_stage_cost(
                    attempt.usage, pricing
                )
                rows.append(
                    [
                        "",
                        attempt.stage,
                        attempt.attempt_label,
                        attempt.usage.model_id,
                        inferred_profile or "unknown",
                        f"{attempt.usage.input_tokens:,}",
                        f"{attempt.usage.output_tokens:,}",
                        f"{attempt.usage.cache_read_tokens:,}",
                        f"{attempt.usage.uncached_input_tokens:,}",
                        f"{attempt.usage.cache_ratio * 100:.2f}%",
                        "effective" if attempt in visible_attempts else "",
                        str(attempt.usage.ai_message_count),
                        format_cost(stage_cost),
                    ]
                )

    return render_rows(header, rows, prefix_lines=render_pricing_header(pricing))


def render_csv(runs: list[RunUsage], config: RenderConfig | None = None) -> str:
    config = config or RenderConfig()
    pricing = resolve_pricing_selection(config.pricing)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "run_dir",
            "run_name",
            "experiment",
            "row_type",
            "stage",
            "scope",
            "attempt_label",
            "model_id",
            "price_profile",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cache_read_tokens",
            "uncached_input_tokens",
            "cache_ratio",
            "ai_message_count",
            "ai_messages_with_usage_count",
            "estimated_cost",
            "currency",
        ]
    )

    def write_usage_row(
        *,
        run: RunUsage,
        row_type: str,
        stage: str,
        scope: str,
        attempt_label: str,
        model_id: str,
        profile: str,
        totals: UsageTotals,
        cost: CostEstimate | None,
    ) -> None:
        writer.writerow(
            [
                run.run_dir,
                Path(run.run_dir).name,
                run.experiment or "",
                row_type,
                stage,
                scope,
                attempt_label,
                model_id,
                profile,
                totals.input_tokens,
                totals.output_tokens,
                totals.total_tokens,
                totals.cache_read_tokens,
                totals.uncached_input_tokens,
                f"{totals.cache_ratio:.6f}",
                totals.ai_message_count,
                totals.ai_messages_with_usage_count,
                f"{cost.amount:.6f}" if cost is not None else "",
                cost.currency if cost is not None else "",
            ]
        )

    for run in runs:
        effective = compute_effective_patch_usage(run)
        run_cost = estimate_run_cost(run, pricing)
        effective_cost = estimate_run_cost(effective_patch_run(run), pricing)
        profile_label = pricing.profile or (
            "auto" if pricing.mode == "auto-profile" else "custom"
        )

        write_usage_row(
            run=run,
            row_type="run",
            stage="TOTAL",
            scope="all",
            attempt_label="",
            model_id="",
            profile=profile_label,
            totals=run.totals,
            cost=run_cost,
        )
        write_usage_row(
            run=run,
            row_type="run",
            stage="TOTAL",
            scope="effective_patch",
            attempt_label="",
            model_id="",
            profile=profile_label,
            totals=effective.totals,
            cost=effective_cost,
        )

        for stage in run.stages:
            stage_cost, inferred_profile = estimate_stage_cost(stage, pricing)
            write_usage_row(
                run=run,
                row_type="stage",
                stage=stage.stage,
                scope="all",
                attempt_label="",
                model_id=stage.model_id,
                profile=inferred_profile or "unknown",
                totals=aggregate_stage_usages([stage]),
                cost=stage_cost,
            )

        displayed_attempt_rows = displayable_attempt_rows(run)
        if displayed_attempt_rows:
            visible_attempts = displayable_effective_attempts(run, effective)
            for attempt in displayed_attempt_rows:
                stage_cost, inferred_profile = estimate_stage_cost(
                    attempt.usage, pricing
                )
                write_usage_row(
                    run=run,
                    row_type="attempt",
                    stage=attempt.stage,
                    scope=(
                        "effective_patch"
                        if attempt in visible_attempts
                        else "all_attempts"
                    ),
                    attempt_label=attempt.attempt_label,
                    model_id=attempt.usage.model_id,
                    profile=inferred_profile or "unknown",
                    totals=aggregate_stage_usages([attempt.usage]),
                    cost=stage_cost,
                )

    return buffer.getvalue()


def render_json(runs: list[RunUsage], config: RenderConfig | None = None) -> str:
    config = config or RenderConfig()
    pricing = resolve_pricing_selection(config.pricing)
    payload: list[dict] = []

    for run in runs:
        run_cost = estimate_run_cost(run, pricing)
        effective = compute_effective_patch_usage(run)
        effective_cost = estimate_run_cost(effective_patch_run(run), pricing)
        totals = run.totals
        effective_totals = effective.totals

        run_payload = {
            "run_dir": run.run_dir,
            "experiment": run.experiment,
            "workflow_kind": run.workflow_kind,
            "retry_count_used": run.retry_count_used,
            "input_tokens": totals.input_tokens,
            "output_tokens": totals.output_tokens,
            "total_tokens": totals.total_tokens,
            "cache_read_tokens": totals.cache_read_tokens,
            "uncached_input_tokens": totals.uncached_input_tokens,
            "cache_ratio": totals.cache_ratio,
            "ai_message_count": totals.ai_message_count,
            "ai_messages_with_usage_count": totals.ai_messages_with_usage_count,
            "pricing": {
                "mode": pricing.mode,
                "profile": pricing.profile,
                "input_rate": pricing.input_rate,
                "cache_rate": pricing.cache_rate,
                "output_rate": pricing.output_rate,
                "currency": pricing.currency,
                "unit": "per_1m_tokens",
            },
            "estimated_cost": asdict(run_cost) if run_cost is not None else None,
            "effective_patch": {
                "input_tokens": effective_totals.input_tokens,
                "output_tokens": effective_totals.output_tokens,
                "total_tokens": effective_totals.total_tokens,
                "cache_read_tokens": effective_totals.cache_read_tokens,
                "uncached_input_tokens": effective_totals.uncached_input_tokens,
                "cache_ratio": effective_totals.cache_ratio,
                "ai_message_count": effective_totals.ai_message_count,
                "ai_messages_with_usage_count": effective_totals.ai_messages_with_usage_count,
                "estimated_cost": (
                    asdict(effective_cost) if effective_cost is not None else None
                ),
                "included_attempts": [
                    {"stage": item.stage, "attempt_label": item.attempt_label}
                    for item in effective.included_attempts
                ],
            },
            "stages": [],
            "attempts": [],
        }

        for stage in run.stages:
            stage_cost, inferred_profile = estimate_stage_cost(stage, pricing)
            stage_payload = asdict(stage)
            stage_payload["uncached_input_tokens"] = stage.uncached_input_tokens
            stage_payload["cache_ratio"] = stage.cache_ratio
            stage_payload["estimated_cost"] = (
                asdict(stage_cost) if stage_cost is not None else None
            )
            stage_payload["price_profile"] = inferred_profile
            run_payload["stages"].append(stage_payload)

        for attempt in run.attempts:
            attempt_payload = {
                "stage": attempt.stage,
                "attempt_label": attempt.attempt_label,
                "usage": asdict(attempt.usage),
            }
            attempt_payload["usage"][
                "uncached_input_tokens"
            ] = attempt.usage.uncached_input_tokens
            attempt_payload["usage"]["cache_ratio"] = attempt.usage.cache_ratio
            run_payload["attempts"].append(attempt_payload)

        payload.append(run_payload)

    return json.dumps(payload, indent=2) + "\n"
