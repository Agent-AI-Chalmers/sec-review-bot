#!/usr/bin/env python3
# Experimental script. It may be incomplete, may not track the latest package
# APIs, and may not fit current run artifacts. Review and adapt this script for
# your own inputs and risk tolerance before use.

"""Preview memory observation extraction without modifying a memory store."""

import argparse
import asyncio
from pathlib import Path

from sec_review_agents.memory.extractor import (
    preview_memory_observation_from_paths,
)
from sec_review_agents.utils.env import bootstrap_agents_env

WARNING = (
    "Experimental local script. This is not an operational memory ingestion path. "
    "It does not use Temporal, does not write the memory DB, and does not validate "
    "that inputs came from a real review. It may not track the latest package "
    "APIs. Review and adapt the script before use; inspect outputs manually."
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Experimentally read review transcripts and write observation Markdown "
            "files to an output directory. " + WARNING
        )
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        type=Path,
        help=(
            "Review artifact directories containing transcripts/, or transcript "
            "JSONL transcript files."
        ),
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="Directory where observation Markdown files will be written.",
    )
    parser.add_argument(
        "--deployment",
        default=None,
        help="Optional LLM deployment override for the memory-extractor agent.",
    )
    id_group = parser.add_mutually_exclusive_group(required=True)
    id_group.add_argument(
        "--observation-id",
        default=None,
        help="Stable observation id for the collected transcript sequence.",
    )
    parser.add_argument(
        "--source-workflow",
        default="experimental-local-preview",
        help="Provenance label written into observation headers.",
    )
    id_group.add_argument(
        "--job-id",
        default=None,
        help="Stable extraction id used to derive the observation id.",
    )
    parser.add_argument(
        "--run-id",
        default=None,
        help="Optional provenance run id written into the observation header.",
    )
    return parser.parse_args()


def _write_observation(path: Path, content: str) -> None:
    """Write one normalized observation document to the requested preview path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


async def main() -> int:
    """Run one local extraction attempt over the supplied transcript sequence."""
    bootstrap_agents_env()
    args = _parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    result = await preview_memory_observation_from_paths(
        args.inputs,
        deployment=args.deployment,
        observation_id_value=args.observation_id,
        job_id=args.job_id,
        source_workflow=args.source_workflow,
        run_id=args.run_id,
        audit_root=output_dir,
    )
    if result.skipped or result.observation_markdown is None:
        print(f"No observation written: {result.summary}")
        return 1

    target = output_dir / f"{result.observation_id}.md"
    _write_observation(target, result.observation_markdown)
    print(f"Wrote {target}")
    print(WARNING)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
