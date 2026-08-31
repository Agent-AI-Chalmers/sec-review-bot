import argparse
from pathlib import Path

from scripts.token_usage import PricingConfig, load_run_usage
from scripts.token_usage.output import (
    RenderConfig,
    render_csv,
    render_json,
    render_price_profiles,
    render_raw_text,
    render_table,
)
from sec_review_agents.utils.env import bootstrap_agents_env


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Summarize token usage for one or more local run directories."
    )
    parser.add_argument(
        "run_dirs",
        nargs="*",
        help="One or more local run roots, e.g. /path/to/local-run-2026... .",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of the default table output.",
    )
    parser.add_argument(
        "--csv", action="store_true", help="Emit CSV with one row per run stage."
    )
    parser.add_argument(
        "--raw",
        action="store_true",
        help="Emit the verbose text breakdown used previously.",
    )
    parser.add_argument(
        "--list-price-profiles",
        action="store_true",
        help="List built-in price profiles and exit.",
    )
    parser.add_argument(
        "--price-profile",
        default=None,
        help=(
            "Built-in price profile to use for cost estimation. "
            "If omitted, infer from each stage model_id when possible."
        ),
    )
    parser.add_argument(
        "--input-rate",
        type=float,
        default=None,
        help="Optional cost rate override for uncached input tokens in currency units per 1M tokens.",
    )
    parser.add_argument(
        "--cache-rate",
        type=float,
        default=None,
        help="Optional cost rate override for cache-read input tokens in currency units per 1M tokens.",
    )
    parser.add_argument(
        "--output-rate",
        type=float,
        default=None,
        help="Optional cost rate override for output tokens in currency units per 1M tokens.",
    )
    return parser.parse_args()


def main() -> None:
    bootstrap_agents_env()
    args = parse_args()

    if args.list_price_profiles:
        print(render_price_profiles(), end="")
        return

    if not args.run_dirs:
        raise SystemExit(
            "Provide at least one run_dir unless using --list-price-profiles."
        )

    if sum(bool(flag) for flag in (args.json, args.csv, args.raw)) > 1:
        raise SystemExit("Choose at most one of --json, --csv, --raw.")

    runs = [load_run_usage(Path(item).resolve()) for item in args.run_dirs]
    render_config = RenderConfig(
        pricing=PricingConfig(
            price_profile=args.price_profile,
            input_rate=args.input_rate,
            cache_rate=args.cache_rate,
            output_rate=args.output_rate,
        )
    )

    if args.json:
        print(render_json(runs, render_config), end="")
    elif args.csv:
        print(render_csv(runs, render_config), end="")
    elif args.raw:
        print(render_raw_text(runs, render_config), end="")
    else:
        print(render_table(runs, render_config), end="")


if __name__ == "__main__":
    main()
