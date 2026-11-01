#!/usr/bin/env python3
import argparse
import hashlib
import json
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

from scripts.patcheval.experiments import (
    EVALUATION_EXPERIMENTS,
    LIGHTWEIGHT_COST_VARIANTS,
)
from scripts.token_usage import (
    PriceIndex,
    collect_used_prices,
    effective_patch_run,
    lightweight_two_stage_run,
    load_price_index,
    load_run_usage,
    run_cost,
)


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
    # Complete-usage runs contributing tokens. Turn coverage can be larger;
    # its denominator is recorded separately in evaluation metadata.
    cost_case_count: int
    # Denominator of avg_price: runs that could be priced. May be smaller than
    # cost_case_count when some run's model was not in the price source.
    cost_priced_count: int
    failure_breakdown: dict
    failed_cves: dict
    output_dir: str


@dataclass
class CostSummary:
    avg_token_k: float | None
    avg_price: float | None
    avg_ai_turns: float | None
    currency: str | None
    # Number of runs that could be priced (the denominator of avg_price).
    priced_case_count: int
    # Number of runs with complete usage contributing token averages.
    run_count: int


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
    for variant in EVALUATION_EXPERIMENTS:
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
    for variant in EVALUATION_EXPERIMENTS:
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


def load_submissions(directory: Path, tag: str, variants: list[str]) -> list[dict]:
    """Join costs to exported attempts, not to whichever symlink exists today."""
    manifest = json.loads((directory / f"patcheval-{tag}-manifest.json").read_text())
    selected = []
    for variant in variants:
        records = [row for row in manifest if row["experiment"] == variant]
        patches = json.loads(
            (directory / f"patcheval-{tag}-{variant}.json").read_text()
        )
        by_cve = {row["cve"]: row for row in records}
        if len(by_cve) != len(records) or len({row["cve"] for row in patches}) != len(
            patches
        ):
            raise ValueError(f"Duplicate submission for {variant}")
        if set(by_cve) != {row["cve"] for row in patches}:
            raise ValueError(f"Submission/manifest task mismatch for {variant}")
        for patch in patches:
            row = by_cve[patch["cve"]]
            if (
                row.get("patch_sha256")
                != hashlib.sha256(patch["fix_patch"].encode()).hexdigest()
            ):
                raise ValueError(
                    f"Submission hash mismatch: {variant}/{patch['cve']}; re-export legacy inputs"
                )
        selected.extend(records)
    return selected


def collect_costs(
    records: list[dict], *, index: PriceIndex | None = None
) -> tuple[dict[str, CostSummary], dict]:
    summaries = {}
    details = {}
    for variant in EVALUATION_EXPERIMENTS:
        submitted = [record for record in records if record["experiment"] == variant]
        runs = []
        missing = []
        partial = []
        for record in submitted:
            path = Path(record["run_dir"]) if record.get("run_dir") else None
            if path is None or not path.is_dir():
                missing.append(record["cve"])
                continue
            run = load_run_usage(path)
            effective = (
                lightweight_two_stage_run(run)
                if variant in LIGHTWEIGHT_COST_VARIANTS.values()
                else effective_patch_run(run)
            )
            if not effective.stages or effective.ai_message_count == 0:
                missing.append(record["cve"])
                continue
            if effective.ai_messages_with_usage_count < effective.ai_message_count:
                partial.append(record["cve"])
            runs.append(effective)
        # Unknown/partial usage never becomes a zero-cost task. Report the
        # coverage explicitly; the denominator is observed tasks, not all 230.
        complete = [
            run
            for run in runs
            if run.ai_messages_with_usage_count == run.ai_message_count
        ]
        prices = [
            cost.amount
            for run in complete
            if (cost := run_cost(run, index)) is not None
        ]
        summaries[variant] = CostSummary(
            avg_token_k=(
                sum(run.total_tokens for run in complete) / len(complete) / 1000
                if complete
                else None
            ),
            avg_price=sum(prices) / len(prices) if prices else None,
            avg_ai_turns=(
                sum(run.ai_message_count for run in runs) / len(runs) if runs else None
            ),
            currency="USD" if prices else None,
            priced_case_count=len(prices),
            run_count=len(complete),
        )
        details[variant] = {
            "submitted_count": len(submitted),
            "missing_usage_cves": missing,
            "partial_usage_cves": partial,
            "turn_case_count": len(runs),
            "used_prices": {
                name: asdict(price) if price else None
                for name, price in collect_used_prices(runs, index).items()
            },
        }
    return summaries, details


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
        cost_case_count=cost.run_count,
        cost_priced_count=cost.priced_case_count,
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
        help="write a separate all-attempts usage audit; never mix retries into submitted-task averages.",
    )
    parser.add_argument(
        "--variant",
        action="append",
        choices=EVALUATION_EXPERIMENTS,
        help="Workflow variant to report; repeatable. Defaults to all.",
    )
    args = parser.parse_args()

    base = Path(args.base)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    variants = list(dict.fromkeys(args.variant or EVALUATION_EXPERIMENTS))
    submissions = load_submissions(Path(args.patch_input_dir), args.tag, variants)
    index = load_price_index()
    costs, cost_details = collect_costs(submissions, index=index)
    metadata = {
        "cost_scope": "effective_patch",
        "pricing_source": "openrouter-reference",
        "fetched_at": index.fetched_at if index else None,
        "variants": cost_details,
    }
    (output_dir / f"patcheval-{args.tag}-evaluation-metadata.json").write_text(
        json.dumps(metadata, indent=2)
    )
    if args.include_unlinked_runs:
        from scripts.token_usage.output import RenderConfig, render_json

        all_runs = [
            load_run_usage(path)
            for path in iter_cost_run_dirs(
                Path(args.workspace_root), args.tag, include_unlinked_runs=True
            )
        ]
        (output_dir / f"patcheval-{args.tag}-all-attempts.json").write_text(
            render_json(all_runs, RenderConfig(index=index))
        )
    cve_languages = read_cve_languages(Path(args.input_file))
    language_totals = collect_language_totals(
        Path(args.patch_input_dir), args.tag, cve_languages
    )

    rows: list[EvaluationRow] = []
    missing: list[Path] = []
    for variant in variants:
        summary_path = base / f"{args.prefix}-{variant}" / "summary.json"
        if not summary_path.exists():
            missing.append(summary_path)
            continue
        evaluator = json.loads(summary_path.read_text())
        expected = {
            record["cve"] for record in submissions if record["experiment"] == variant
        }
        observed = {
            cve
            for groups in (
                evaluator["strict_evaluation"]["successful_cves"],
                evaluator["failure_analysis"]["failed_cves"],
            )
            for cves in groups.values()
            for cve in cves
        }
        if observed != expected:
            raise ValueError(
                f"Evaluator task identities differ from submission: {variant}"
            )
        if evaluator["strict_evaluation"]["total_cases"] != len(expected):
            raise ValueError(
                f"Evaluator denominator differs from submission: {variant}"
            )
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
