#!/usr/bin/env python3
# Experimental script. It may be incomplete, may not track the latest package
# APIs, and may not fit current memory or observation files. Review and adapt
# this script for your own inputs and risk tolerance before use.

"""Import observation Markdown files and run direct memory maintenance."""

import argparse
import asyncio
import tempfile
from pathlib import Path

from sec_review_agents.memory.local_state import (
    OBSERVATION_STATUS_PENDING,
    fetch_observation_by_id,
    open_memory_state,
    upsert_observation,
)
from sec_review_agents.memory.local_store import (
    initialize_memory_store,
    memory_observations_dir,
    memory_store_lock,
)
from sec_review_agents.memory.maintainer import maintain_memory_with_result
from sec_review_agents.utils.env import bootstrap_agents_env

WARNING = (
    "Experimental local script. This is not an operational memory maintenance "
    "path. It does not use Temporal, but it writes the normal memory DB and may "
    "overwrite memory/MEMORY.md and memory/topics/*.md. It may not track the "
    "latest package APIs. Review and adapt the script before use. Run it only on "
    "a copied or temporary memory store unless you are ready to inspect and keep "
    "the diff."
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Experimentally maintain an AGENT_MEMORY_DIR memory store using "
            "observation Markdown files. " + WARNING
        )
    )
    parser.add_argument(
        "--memory-store-dir",
        required=True,
        type=Path,
        help=(
            "Writable AGENT_MEMORY_DIR memory store to modify. Prefer a copy or "
            "temporary store."
        ),
    )
    parser.add_argument(
        "--observations-dir",
        type=Path,
        default=None,
        help="Directory containing observation Markdown files.",
    )
    parser.add_argument(
        "--observation",
        action="append",
        type=Path,
        default=[],
        help="Observation Markdown file. May be repeated.",
    )
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help=(
            "Replace observation ids already present in the memory ledger and "
            "mark them pending again."
        ),
    )
    parser.add_argument(
        "--deployment",
        default=None,
        help="Optional LLM deployment override for the memory-maintainer agent.",
    )
    return parser.parse_args()


def _collect_observations(args: argparse.Namespace) -> list[Path]:
    """Resolve explicitly selected observation files in deterministic order."""
    paths: list[Path] = []
    if args.observations_dir is not None:
        observations_dir = args.observations_dir.expanduser().resolve()
        if not observations_dir.is_dir():
            raise FileNotFoundError(
                f"Observations dir does not exist: {observations_dir}"
            )
        paths.extend(sorted(observations_dir.glob("*.md")))
    paths.extend(path.expanduser().resolve() for path in args.observation)

    unique: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        if path in seen:
            continue
        if not path.is_file():
            raise FileNotFoundError(f"Observation file does not exist: {path}")
        seen.add(path)
        unique.append(path)
    return unique


def _import_observations(
    observation_paths: list[Path],
    *,
    memory_store_dir: Path,
    replace_existing: bool,
) -> None:
    """Publish new observations, rejecting existing ledger ids by default."""
    observations_root = memory_observations_dir(memory_store_dir)
    observation_ids = [source.stem for source in observation_paths]
    if len(observation_ids) != len(set(observation_ids)):
        raise ValueError("Observation input file stems must be unique.")
    with (
        memory_store_lock(memory_store_dir, exclusive=True),
        open_memory_state(memory_store_dir) as connection,
    ):
        existing_ids = [
            observation_id
            for observation_id in observation_ids
            if fetch_observation_by_id(connection, observation_id) is not None
        ]
        if existing_ids and not replace_existing:
            formatted_ids = ", ".join(sorted(existing_ids))
            raise FileExistsError(
                "Observations already exist in the memory ledger: "
                f"{formatted_ids}. Pass --replace-existing to replace them."
            )

        for source in observation_paths:
            observation_id = source.stem
            target = observations_root / f"{observation_id}.md"
            content = source.read_bytes()
            with tempfile.NamedTemporaryFile(
                "wb",
                dir=observations_root,
                prefix=f".{observation_id}.",
                suffix=".tmp",
                delete=False,
            ) as temp_file:
                temp_path = Path(temp_file.name)
                temp_file.write(content)
            temp_path.replace(target)
            upsert_observation(
                connection,
                observation_id=observation_id,
                path=str(target),
                status=OBSERVATION_STATUS_PENDING,
            )


async def main() -> int:
    """Run the experimental non-Temporal maintenance command."""
    bootstrap_agents_env()
    args = _parse_args()
    print(WARNING)

    memory_store_dir = args.memory_store_dir.expanduser().resolve()
    initialize_memory_store(memory_store_dir)
    observation_paths = _collect_observations(args)
    if not observation_paths:
        print("No observation Markdown files selected.")
        return 1

    _import_observations(
        observation_paths,
        memory_store_dir=memory_store_dir,
        replace_existing=args.replace_existing,
    )
    result = await maintain_memory_with_result(
        memory_store_dir=memory_store_dir,
        deployment=args.deployment,
        observation_ids=[path.stem for path in observation_paths],
    )

    print(result.summary)
    print(f"Inspect {memory_store_dir} before keeping the changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
