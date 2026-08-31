#!/usr/bin/env python3
import argparse
import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

from scripts.token_usage import (
    PricingSelection,
    effective_patch_run,
    estimate_run_cost,
    lightweight_two_stage_run,
    load_run_usage,
)

VARIANTS = (
    "end-to-end-default",
    "end-to-end-lightweight-two-stage",
    "end-to-end-single-agent",
    "end-to-end-two-stage",
    "location-oracle-default",
    "location-oracle-lightweight-two-stage",
    "location-oracle-single-agent",
    "location-oracle-two-stage",
)
# lightweight-two-stage is a derived cost view of default runs, not a separate
# PatchEval execution variant.
LIGHTWEIGHT_COST_VARIANTS = {
    "end-to-end-default": "end-to-end-lightweight-two-stage",
    "location-oracle-default": "location-oracle-lightweight-two-stage",
}


@dataclass
class EvaluationRow:
    variant: str
    total: int
    strict_success: int
    strict_rate: str
    strict_rate_with_count: str
    strict_language_breakdown: dict
    strict_rates_by_language: dict
    strict_rates_by_language_with_counts: dict
    strict_successful_cves: dict
    poc_success: int
    poc_rate: str
    poc_rate_with_count: str
    poc_language_breakdown: dict
    poc_rates_by_language: dict
    poc_rates_by_language_with_counts: dict
    poc_successful_cves: dict
    avg_token_k: float | None
    avg_price: float | None
    avg_ai_turns: float | None
    currency: str | None
    cost_case_count: int
    failure_breakdown: dict
    failed_cves: dict
    output_dir: str


@dataclass
class CostSummary:
    avg_token_k: float | None
    avg_price: float | None
    avg_ai_turns: float | None
    currency: str | None
    case_count: int


def format_percent(numerator: int, denominator: int) -> str:
    if denominator <= 0:
        return "N/A"
    return f"{(numerator / denominator) * 100:.1f}%"


def read_cve_languages(input_file: Path) -> dict[str, str]:
    items = json.loads(input_file.read_text(encoding="utf-8"))
    return {str(item["cve_id"]): str(item["programming_language"]) for item in items}


def collect_language_totals(
    patch_input_dir: Path, tag: str, cve_languages: dict[str, str]
) -> dict[str, dict[str, int]]:
    totals: dict[str, dict[str, int]] = {}
    for variant in VARIANTS:
        patch_file = patch_input_dir / f"patcheval-{tag}-{variant}.json"
        if not patch_file.exists():
            totals[variant] = {}
            continue
        patches = json.loads(patch_file.read_text(encoding="utf-8"))
        counter: Counter[str] = Counter()
        for patch in patches:
            cve = str(patch["cve"])
            language = cve_languages.get(cve, "Unknown")
            counter[language] += 1
        totals[variant] = dict(sorted(counter.items()))
    return totals


def rates_by_language(
    success_breakdown: dict, language_totals: dict[str, int]
) -> tuple[dict[str, str], dict[str, str]]:
    languages = sorted(set(language_totals) | set(success_breakdown))
    rate_dict = {}
    rate_with_count_dict = {}
    for language in languages:
        success = int(success_breakdown.get(language, 0))
        total = int(language_totals.get(language, 0))
        rate_dict[language] = format_percent(success, total)
        if total > 0:
            rate_with_count_dict[language] = (
                f"{rate_dict[language]} ({success}/{total})"
            )
        else:
            rate_with_count_dict[language] = "N/A"
    return rate_dict, rate_with_count_dict


def experiment_variant(experiment_name: str) -> str | None:
    for variant in VARIANTS:
        if experiment_name.endswith(f"-{variant}"):
            return variant
    return None


def iter_cost_run_dirs(
    workspace_root: Path, tag: str, *, include_unlinked_runs: bool = False
):
    if include_unlinked_runs:
        yield from sorted(
            workspace_root.glob(f".agent-workspace-patcheval-CVE-*-{tag}/local-run-*")
        )
        return

    for workspace_dir in sorted(
        workspace_root.glob(f".agent-workspace-patcheval-CVE-*-{tag}")
    ):
        workspace_name = workspace_dir.name
        prefix = ".agent-workspace-patcheval-"
        suffix = f"-{tag}"
        if not workspace_name.startswith(prefix) or not workspace_name.endswith(suffix):
            continue
        cve = workspace_name[len(prefix) : -len(suffix)]
        for experiment_dir in sorted(workspace_dir.glob(f"{cve}-*")):
            if experiment_dir.is_dir():
                yield experiment_dir.resolve()


def collect_costs(
    workspace_root: Path, tag: str, *, include_unlinked_runs: bool = False
) -> dict[str, CostSummary]:
    pricing = PricingSelection(
        mode="auto-profile",
        profile=None,
        input_rate=None,
        cache_rate=None,
        output_rate=None,
        currency=None,
    )
    tokens_by_variant: dict[str, list[int]] = {variant: [] for variant in VARIANTS}
    costs_by_variant: dict[str, list[float]] = {variant: [] for variant in VARIANTS}
    ai_turns_by_variant: dict[str, list[int]] = {variant: [] for variant in VARIANTS}
    currencies_by_variant: dict[str, set[str]] = {
        variant: set() for variant in VARIANTS
    }

    for run_dir in iter_cost_run_dirs(
        workspace_root, tag, include_unlinked_runs=include_unlinked_runs
    ):
        run = load_run_usage(run_dir)
        if not run.experiment:
            continue
        variant = experiment_variant(run.experiment)
        if variant is None:
            continue
        effective = effective_patch_run(run)
        tokens_by_variant[variant].append(effective.total_tokens)
        ai_turns_by_variant[variant].append(effective.totals.ai_message_count)
        cost = estimate_run_cost(effective, pricing)
        if cost is not None:
            costs_by_variant[variant].append(cost.amount)
            currencies_by_variant[variant].add(cost.currency)

        lightweight_variant = LIGHTWEIGHT_COST_VARIANTS.get(variant)
        if lightweight_variant is not None:
            lightweight_effective = lightweight_two_stage_run(run)
            tokens_by_variant[lightweight_variant].append(
                lightweight_effective.total_tokens
            )
            ai_turns_by_variant[lightweight_variant].append(
                lightweight_effective.totals.ai_message_count
            )
            lightweight_cost = estimate_run_cost(lightweight_effective, pricing)
            if lightweight_cost is not None:
                costs_by_variant[lightweight_variant].append(lightweight_cost.amount)
                currencies_by_variant[lightweight_variant].add(
                    lightweight_cost.currency
                )

    summaries: dict[str, CostSummary] = {}
    for variant in VARIANTS:
        token_values = tokens_by_variant[variant]
        cost_values = costs_by_variant[variant]
        ai_turn_values = ai_turns_by_variant[variant]
        currencies = currencies_by_variant[variant]
        summaries[variant] = CostSummary(
            avg_token_k=(
                (sum(token_values) / len(token_values) / 1000.0)
                if token_values
                else None
            ),
            avg_price=(sum(cost_values) / len(cost_values)) if cost_values else None,
            avg_ai_turns=(
                (sum(ai_turn_values) / len(ai_turn_values)) if ai_turn_values else None
            ),
            currency=next(iter(currencies)) if len(currencies) == 1 else None,
            case_count=len(token_values),
        )
    return summaries


def read_summary(
    summary_path: Path, variant: str, cost: CostSummary, language_totals: dict[str, int]
) -> EvaluationRow:
    data = json.loads(summary_path.read_text(encoding="utf-8"))
    strict = data["strict_evaluation"]
    poc = data["poc_only_evaluation"]
    strict_rates, strict_rates_with_counts = rates_by_language(
        strict["success_breakdown"], language_totals
    )
    poc_rates, poc_rates_with_counts = rates_by_language(
        poc["success_breakdown"], language_totals
    )
    return EvaluationRow(
        variant=variant,
        total=strict["total_cases"],
        strict_success=strict["total_success"],
        strict_rate=strict["pass_rate"],
        strict_rate_with_count=f"{strict['pass_rate']} ({strict['total_success']}/{strict['total_cases']})",
        strict_language_breakdown=strict["success_breakdown"],
        strict_rates_by_language=strict_rates,
        strict_rates_by_language_with_counts=strict_rates_with_counts,
        strict_successful_cves=strict["successful_cves"],
        poc_success=poc["total_success"],
        poc_rate=poc["pass_rate"],
        poc_rate_with_count=f"{poc['pass_rate']} ({poc['total_success']}/{poc['total_cases']})",
        poc_language_breakdown=poc["success_breakdown"],
        poc_rates_by_language=poc_rates,
        poc_rates_by_language_with_counts=poc_rates_with_counts,
        poc_successful_cves=poc["successful_cves"],
        avg_token_k=(
            round(cost.avg_token_k, 2) if cost.avg_token_k is not None else None
        ),
        avg_price=round(cost.avg_price, 6) if cost.avg_price is not None else None,
        avg_ai_turns=(
            round(cost.avg_ai_turns, 2) if cost.avg_ai_turns is not None else None
        ),
        currency=cost.currency,
        cost_case_count=cost.case_count,
        failure_breakdown=data["failure_analysis"]["breakdown"],
        failed_cves=data["failure_analysis"]["failed_cves"],
        output_dir=str(summary_path.parent),
    )


def all_languages(rows: list[EvaluationRow], metric: str) -> list[str]:
    languages: set[str] = set()
    for row in rows:
        rates = (
            row.strict_rates_by_language
            if metric == "strict"
            else row.poc_rates_by_language
        )
        languages.update(rates)
    return sorted(languages)


def render_table(title: str, rows: list[EvaluationRow], metric: str) -> None:
    languages = all_languages(rows, metric)
    headers = [
        "Variant",
        "Overall",
        *languages,
        "Avg Token (K)",
        "Avg AI Turns",
        "Avg Price",
    ]
    print()
    print(f"{title}:")
    print("| " + " | ".join(headers) + " |")
    print("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        if metric == "strict":
            overall = row.strict_rate_with_count
            rates = row.strict_rates_by_language_with_counts
        else:
            overall = row.poc_rate_with_count
            rates = row.poc_rates_by_language_with_counts
        price = (
            f"{row.avg_price:.6f} {row.currency}"
            if row.avg_price is not None and row.currency
            else "N/A"
        )
        token = f"{row.avg_token_k:.2f}" if row.avg_token_k is not None else "N/A"
        ai_turns = f"{row.avg_ai_turns:.2f}" if row.avg_ai_turns is not None else "N/A"
        values = [
            row.variant,
            overall,
            *[rates.get(language, "N/A") for language in languages],
            token,
            ai_turns,
            price,
        ]
        print("| " + " | ".join(values) + " |")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize PatchEval run_evaluation.py outputs."
    )
    parser.add_argument(
        "--tag", default="DEEPSEEK-V4-PRO", help="tag used in output summary filename"
    )
    parser.add_argument(
        "--prefix", default="deepseek-v4-pro", help="evaluation output directory prefix"
    )
    parser.add_argument(
        "--base",
        default="PatchEval/patcheval/evaluation/evaluation_output",
        help="directory containing PatchEval evaluation output dirs",
    )
    parser.add_argument(
        "--output-dir", default="evaluation_output", help="directory for summary JSON"
    )
    parser.add_argument(
        "--workspace-root",
        default=".",
        help="repository root containing agent workspace dirs",
    )
    parser.add_argument(
        "--patch-input-dir",
        default="evaluation_input",
        help="directory containing collected patch JSON",
    )
    parser.add_argument(
        "--input-file",
        default="PatchEval/patcheval/datasets/input.json",
        help="PatchEval input metadata JSON",
    )
    parser.add_argument(
        "--include-unlinked-runs",
        action="store_true",
        help="include every local-run-* directory in cost averages. By default only current experiment symlinks are used.",
    )
    args = parser.parse_args()

    base = Path(args.base)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    costs = collect_costs(
        Path(args.workspace_root),
        args.tag,
        include_unlinked_runs=args.include_unlinked_runs,
    )
    cve_languages = read_cve_languages(Path(args.input_file))
    language_totals = collect_language_totals(
        Path(args.patch_input_dir), args.tag, cve_languages
    )

    rows: list[EvaluationRow] = []
    missing: list[Path] = []
    for variant in VARIANTS:
        summary_path = base / f"{args.prefix}-{variant}" / "summary.json"
        if not summary_path.exists():
            missing.append(summary_path)
            continue
        rows.append(
            read_summary(
                summary_path, variant, costs[variant], language_totals[variant]
            )
        )

    output_path = output_dir / f"patcheval-{args.tag}-evaluation-summary.json"
    output_path.write_text(
        json.dumps([asdict(row) for row in rows], indent=2), encoding="utf-8"
    )

    print(output_path)
    render_table("Strict", rows, "strict")
    render_table("PoC-only", rows, "poc")
    if missing:
        print("Missing summary.json files:")
        for path in missing:
            print(f"  {path}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
