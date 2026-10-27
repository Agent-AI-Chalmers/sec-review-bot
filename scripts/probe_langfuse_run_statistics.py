import argparse
import json
import os
from typing import Any

from langfuse import Langfuse
from scripts.execution_statistics.langfuse_run import (
    aggregate_run,
    read_run_observations,
)


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read one review run from Langfuse and print observed model-call "
            "statistics as JSON. This probe is read-only and does not persist data."
        )
    )
    parser.add_argument("run_id", help="Review execution run_id / Langfuse session ID.")
    parser.add_argument(
        "--page-size",
        type=int,
        default=100,
        help="Langfuse observations page size (default: 100).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.page_size < 1 or args.page_size > 1000:
        raise SystemExit("--page-size must be between 1 and 1000")

    client = Langfuse(
        public_key=_required_env("LANGFUSE_PUBLIC_KEY"),
        secret_key=_required_env("LANGFUSE_SECRET_KEY"),
        base_url=_required_env("LANGFUSE_BASE_URL"),
    )
    try:
        read_result = read_run_observations(
            client.api.observations,
            run_id=args.run_id,
            page_size=args.page_size,
        )
        snapshot: dict[str, Any] = aggregate_run(
            run_id=args.run_id,
            generations=read_result.generations,
            root_count=len(read_result.roots),
            excluded_non_review_root_count=(read_result.excluded_non_review_root_count),
            excluded_non_langchain_generation_count=(
                read_result.excluded_non_langchain_generation_count
            ),
        )
        print(json.dumps(snapshot, indent=2, sort_keys=True))
    finally:
        client.shutdown()


if __name__ == "__main__":
    main()
