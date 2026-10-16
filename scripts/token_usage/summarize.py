import argparse
from pathlib import Path

from sec_review_agents.utils.env import bootstrap_agents_env

from scripts.token_usage import load_run_usage
from scripts.token_usage.openrouter_pricing import load_price_index
from scripts.token_usage.output import (
    RenderConfig,
    render_csv,
    render_json,
    render_raw_text,
    render_table,
)


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
    return parser.parse_args()


def main() -> None:
    bootstrap_agents_env()
    args = parse_args()

    if not args.run_dirs:
        raise SystemExit("Provide at least one run_dir.")

    if sum(bool(flag) for flag in (args.json, args.csv, args.raw)) > 1:
        raise SystemExit("Choose at most one of --json, --csv, --raw.")

    runs = [load_run_usage(Path(item).resolve()) for item in args.run_dirs]
    index = load_price_index()
    render_config = RenderConfig(index=index)

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
