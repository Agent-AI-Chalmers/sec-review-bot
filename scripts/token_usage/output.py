import csv
import io
import json
from dataclasses import asdict
from pathlib import Path

from .effective import compute_effective_patch_usage, effective_patch_efficiency
from .models import (
    AttemptUsage,
    EffectivePatchUsage,
    RunUsage,
    UsageTotals,
    aggregate_stage_usages,
)


def format_count(value: int | None) -> str:
    return "unknown" if value is None else f"{value:,}"


def format_ratio(value: float | None) -> str:
    return "unknown" if value is None else f"{value * 100:.2f}%"


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


def render_raw_text(runs: list[RunUsage]) -> str:
    lines: list[str] = []

    for run in runs:
        effective = compute_effective_patch_usage(run)
        totals = effective.totals
        visible_attempts = displayable_effective_attempts(run, effective)

        lines.append(run.run_dir)
        lines.append(
            f"  usage_source={run.totals.usage_source} usage_complete={run.totals.usage_complete}"
        )
        lines.append(
            "  total: "
            f"input={format_count(run.input_tokens)} "
            f"output={format_count(run.output_tokens)} "
            f"total={format_count(run.total_tokens)} "
            f"cache_read={format_count(run.cache_read_input_tokens)} "
            f"cache_creation={format_count(run.totals.cache_creation_input_tokens)} "
            f"reasoning={format_count(run.totals.reasoning_tokens)} "
            f"uncached_input={format_count(run.uncached_input_tokens)} "
            f"cache_ratio={format_ratio(run.cache_ratio)} "
            f"ai_msgs={run.ai_message_count}"
        )
        lines.append(
            "  effective_patch: "
            f"input={format_count(totals.input_tokens)} "
            f"output={format_count(totals.output_tokens)} "
            f"total={format_count(totals.total_tokens)} "
            f"cache_read={format_count(totals.cache_read_input_tokens)} "
            f"cache_creation={format_count(totals.cache_creation_input_tokens)} "
            f"reasoning={format_count(totals.reasoning_tokens)} "
            f"uncached_input={format_count(totals.uncached_input_tokens)} "
            f"cache_ratio={format_ratio(totals.cache_ratio)} "
            f"ai_msgs={totals.ai_message_count}"
        )
        if visible_attempts:
            labels = ", ".join(
                f"{item.stage}.{item.attempt_label}" for item in visible_attempts
            )
            lines.append(f"  effective_patch_attempts={labels}")

        for stage in run.stages:
            line = (
                "  - "
                f"{stage.stage}: "
                f"model_id={stage.model_id} "
                f"input={format_count(stage.input_tokens)} "
                f"output={format_count(stage.output_tokens)} "
                f"total={format_count(stage.total_tokens)} "
                f"cache_read={format_count(stage.cache_read_input_tokens)} "
                f"cache_creation={format_count(stage.cache_creation_input_tokens)} "
                f"reasoning={format_count(stage.reasoning_tokens)} "
                f"uncached_input={format_count(stage.uncached_input_tokens)} "
                f"cache_ratio={format_ratio(stage.cache_ratio)} "
                f"ai_msgs={stage.ai_message_count}"
            )
            lines.append(line)
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def render_table(runs: list[RunUsage]) -> str:
    header = [
        "run",
        "stage",
        "scope",
        "model",
        "input",
        "output",
        "total",
        "reasoning",
        "cache_read",
        "cache_creation",
        "uncached",
        "cache_ratio",
        "efficiency",
        "ai_msgs",
    ]
    rows: list[list[str]] = []

    for run in runs:
        effective = compute_effective_patch_usage(run)
        effective_totals = effective.totals
        efficiency = effective_patch_efficiency(run)

        rows.append(
            [
                display_run_name(run),
                "TOTAL",
                "all",
                "-",
                format_count(run.input_tokens),
                format_count(run.output_tokens),
                format_count(run.total_tokens),
                format_count(run.totals.reasoning_tokens),
                format_count(run.cache_read_input_tokens),
                format_count(run.totals.cache_creation_input_tokens),
                format_count(run.uncached_input_tokens),
                format_ratio(run.cache_ratio),
                format_ratio(efficiency),
                str(run.ai_message_count),
            ]
        )
        rows.append(
            [
                "",
                "TOTAL",
                "effective_patch",
                "-",
                format_count(effective_totals.input_tokens),
                format_count(effective_totals.output_tokens),
                format_count(effective_totals.total_tokens),
                format_count(effective_totals.reasoning_tokens),
                format_count(effective_totals.cache_read_input_tokens),
                format_count(effective_totals.cache_creation_input_tokens),
                format_count(effective_totals.uncached_input_tokens),
                format_ratio(effective_totals.cache_ratio),
                format_ratio(efficiency),
                str(effective_totals.ai_message_count),
            ]
        )

        for stage in run.stages:
            rows.append(
                [
                    "",
                    stage.stage,
                    "all",
                    stage.model_id,
                    format_count(stage.input_tokens),
                    format_count(stage.output_tokens),
                    format_count(stage.total_tokens),
                    format_count(stage.reasoning_tokens),
                    format_count(stage.cache_read_input_tokens),
                    format_count(stage.cache_creation_input_tokens),
                    format_count(stage.uncached_input_tokens),
                    format_ratio(stage.cache_ratio),
                    "",
                    str(stage.ai_message_count),
                ]
            )

        displayed_attempt_rows = displayable_attempt_rows(run)
        if displayed_attempt_rows:
            visible_attempts = displayable_effective_attempts(run, effective)
            for attempt in displayed_attempt_rows:
                rows.append(
                    [
                        "",
                        attempt.stage,
                        attempt.attempt_label,
                        attempt.usage.model_id,
                        format_count(attempt.usage.input_tokens),
                        format_count(attempt.usage.output_tokens),
                        format_count(attempt.usage.total_tokens),
                        format_count(attempt.usage.reasoning_tokens),
                        format_count(attempt.usage.cache_read_input_tokens),
                        format_count(attempt.usage.cache_creation_input_tokens),
                        format_count(attempt.usage.uncached_input_tokens),
                        format_ratio(attempt.usage.cache_ratio),
                        "effective" if attempt in visible_attempts else "",
                        str(attempt.usage.ai_message_count),
                    ]
                )

    coverage = "\n".join(
        f"{display_run_name(run)}: usage_source={run.totals.usage_source}, usage_complete={run.totals.usage_complete}"
        for run in runs
    )
    return render_rows(header, rows) + "\n" + coverage + "\n"


def render_csv(runs: list[RunUsage]) -> str:
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
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "reasoning_tokens",
            "uncached_input_tokens",
            "cache_ratio",
            "ai_message_count",
            "ai_messages_with_usage_count",
            "model_call_count",
            "model_calls_with_usage_count",
            "usage_source",
            "usage_complete",
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
        totals: UsageTotals,
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
                totals.input_tokens,
                totals.output_tokens,
                totals.total_tokens,
                totals.cache_read_input_tokens,
                totals.cache_creation_input_tokens,
                totals.reasoning_tokens,
                totals.uncached_input_tokens,
                ("" if totals.cache_ratio is None else f"{totals.cache_ratio:.6f}"),
                totals.ai_message_count,
                totals.ai_messages_with_usage_count,
                totals.model_call_count,
                totals.model_calls_with_usage_count,
                totals.usage_source,
                totals.usage_complete,
            ]
        )

    for run in runs:
        effective = compute_effective_patch_usage(run)
        write_usage_row(
            run=run,
            row_type="run",
            stage="TOTAL",
            scope="all",
            attempt_label="",
            model_id="",
            totals=run.totals,
        )
        write_usage_row(
            run=run,
            row_type="run",
            stage="TOTAL",
            scope="effective_patch",
            attempt_label="",
            model_id="",
            totals=effective.totals,
        )

        for stage in run.stages:
            write_usage_row(
                run=run,
                row_type="stage",
                stage=stage.stage,
                scope="all",
                attempt_label="",
                model_id=stage.model_id,
                totals=aggregate_stage_usages([stage]),
            )

        displayed_attempt_rows = displayable_attempt_rows(run)
        if displayed_attempt_rows:
            visible_attempts = displayable_effective_attempts(run, effective)
            for attempt in displayed_attempt_rows:
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
                    totals=aggregate_stage_usages([attempt.usage]),
                )

    return buffer.getvalue()


def render_json(runs: list[RunUsage]) -> str:
    payload: list[dict] = []

    for run in runs:
        effective = compute_effective_patch_usage(run)
        totals = run.totals
        effective_totals = effective.totals

        run_payload = {
            "usage_source": totals.usage_source,
            "usage_complete": totals.usage_complete,
            "model_call_count": totals.model_call_count,
            "model_calls_with_usage_count": totals.model_calls_with_usage_count,
            "run_dir": run.run_dir,
            "experiment": run.experiment,
            "workflow_kind": run.workflow_kind,
            "retry_count_used": run.retry_count_used,
            "input_tokens": totals.input_tokens,
            "output_tokens": totals.output_tokens,
            "total_tokens": totals.total_tokens,
            "cache_read_input_tokens": totals.cache_read_input_tokens,
            "cache_creation_input_tokens": totals.cache_creation_input_tokens,
            "reasoning_tokens": totals.reasoning_tokens,
            "uncached_input_tokens": totals.uncached_input_tokens,
            "cache_ratio": totals.cache_ratio,
            "ai_message_count": totals.ai_message_count,
            "ai_messages_with_usage_count": totals.ai_messages_with_usage_count,
            "effective_patch": {
                "usage_source": effective_totals.usage_source,
                "usage_complete": effective_totals.usage_complete,
                "model_call_count": effective_totals.model_call_count,
                "model_calls_with_usage_count": effective_totals.model_calls_with_usage_count,
                "input_tokens": effective_totals.input_tokens,
                "output_tokens": effective_totals.output_tokens,
                "total_tokens": effective_totals.total_tokens,
                "cache_read_input_tokens": effective_totals.cache_read_input_tokens,
                "cache_creation_input_tokens": effective_totals.cache_creation_input_tokens,
                "reasoning_tokens": effective_totals.reasoning_tokens,
                "uncached_input_tokens": effective_totals.uncached_input_tokens,
                "cache_ratio": effective_totals.cache_ratio,
                "ai_message_count": effective_totals.ai_message_count,
                "ai_messages_with_usage_count": effective_totals.ai_messages_with_usage_count,
                "included_attempts": [
                    {"stage": item.stage, "attempt_label": item.attempt_label}
                    for item in effective.included_attempts
                ],
            },
            "stages": [],
            "attempts": [],
        }

        for stage in run.stages:
            stage_payload = asdict(stage)
            stage_payload["uncached_input_tokens"] = stage.uncached_input_tokens
            stage_payload["cache_ratio"] = stage.cache_ratio
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
