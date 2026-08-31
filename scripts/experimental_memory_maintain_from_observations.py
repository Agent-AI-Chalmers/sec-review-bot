#!/usr/bin/env python3
# Experimental script. It may be incomplete, may not track the latest package
# APIs, and may not fit current memory or observation files. Review and adapt
# this script for your own inputs and risk tolerance before use.

import argparse
import asyncio
import shutil
import tempfile
from pathlib import Path

from sec_review_agents.agents.memory_maintainer.agent import (
    MEMORY_MAINTAINER_AGENT_NAME,
    create_memory_maintainer_agent_graph,
)
from sec_review_agents.agents.memory_maintainer.model import (
    MemoryMaintenanceObservation,
)
from sec_review_agents.agents.memory_maintainer.prompts import (
    MEMORY_MAINTAINER_SYSTEM_PROMPT,
    build_maintenance_prompt,
)
from sec_review_agents.filesystem.backend_factory import create_backend_with_materials
from sec_review_agents.filesystem.material_views import writable_memory_view
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.maintainer import (
    _publish_maintained_memory,
)
from sec_review_agents.memory.state import ObservationRow
from sec_review_agents.memory.store import (
    initialize_memory_store,
    memory_content_dir,
)
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import managed_backend
from sec_review_agents.utils.env import bootstrap_agents_env
from sec_review_agents.utils.time import utc_now_iso

WARNING = (
    "Experimental local script. This is not an operational memory maintenance "
    "path. It does not use Temporal, does not read or write the memory DB, and "
    "may overwrite memory/MEMORY.md and memory/topics/*.md. It may not track the "
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
        "--deployment",
        default=None,
        help="Optional LLM deployment override for the memory-maintainer agent.",
    )
    return parser.parse_args()


def _collect_observations(args: argparse.Namespace) -> list[Path]:
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


def _copy_memory_source(memory_store_dir: Path, worktree: Path) -> None:
    worktree.mkdir(parents=True, exist_ok=True)
    memory_path = memory_content_dir(memory_store_dir)
    index = memory_path / "MEMORY.md"
    if not index.is_file():
        raise FileNotFoundError(f"Memory index does not exist: {index}")
    shutil.copy2(index, worktree / "MEMORY.md")

    topics_source = memory_path / "topics"
    topics_target = worktree / "topics"
    if topics_source.is_dir():
        shutil.copytree(topics_source, topics_target, dirs_exist_ok=True)
    else:
        topics_target.mkdir(exist_ok=True)
    (worktree / "observations").mkdir(exist_ok=True)


def _stage_observations(
    observation_paths: list[Path],
    *,
    worktree: Path,
) -> list[ObservationRow]:
    rows: list[ObservationRow] = []
    now = utc_now_iso()
    observations_root = worktree / "observations"
    for index, source in enumerate(observation_paths, start=1):
        observation_id = source.stem or f"observation-{index:04d}"
        target = observations_root / f"{index:04d}-{source.name}"
        shutil.copy2(source, target)
        rows.append(
            ObservationRow(
                observation_id=observation_id,
                path=str(target),
                status="pending",
                created_at=now,
                updated_at=now,
            )
        )
    return rows


def _maintenance_prompt_observations(
    rows: list[ObservationRow],
) -> list[MemoryMaintenanceObservation]:
    return [
        MemoryMaintenanceObservation(
            observation_id=row.observation_id,
            mounted_path=f"/memory/observations/{Path(row.path).name}",
        )
        for row in rows
    ]


async def main() -> int:
    bootstrap_agents_env()
    args = _parse_args()
    print(WARNING)

    memory_store_dir = args.memory_store_dir.expanduser().resolve()
    initialize_memory_store(memory_store_dir)
    observation_paths = _collect_observations(args)
    if not observation_paths:
        print("No observation Markdown files selected.")
        return 1

    with tempfile.TemporaryDirectory(
        prefix="sec-review-memory-maintenance-experiment-"
    ) as tempdir:
        worktree = Path(tempdir) / "memory"
        _copy_memory_source(memory_store_dir, worktree)
        rows = _stage_observations(observation_paths, worktree=worktree)

        backend = create_backend_with_materials(
            container_name_prefix="memory-maintenance-experiment",
            material_views=[writable_memory_view(host_path=worktree)],
            use_docker_sandbox=False,
        )
        model = create_chat_model(
            agent_name=MEMORY_MAINTAINER_AGENT_NAME,
            deployment_override=args.deployment,
        )
        with managed_backend(backend):
            agent = await create_memory_maintainer_agent_graph(
                model=model,
                backend=backend,
                worktree_root=worktree,
            )
            await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=MEMORY_MAINTAINER_AGENT_NAME,
                system_prompt=MEMORY_MAINTAINER_SYSTEM_PROMPT,
                user_prompt=build_maintenance_prompt(
                    _maintenance_prompt_observations(rows)
                ),
            )
        _publish_maintained_memory(source=worktree, memory_store_dir=memory_store_dir)

    print(
        f"Maintained {memory_store_dir} from {len(observation_paths)} observation files. "
        "Inspect the memory store diff before keeping it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
