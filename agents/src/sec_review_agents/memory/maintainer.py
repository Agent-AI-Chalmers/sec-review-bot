"""Run the memory-maintainer agent against explicit tree and observation inputs."""

import shutil
from dataclasses import dataclass
from pathlib import Path

from sec_review_agents.agents.memory_maintainer.agent import (
    MEMORY_MAINTAINER_AGENT_NAME,
    create_memory_maintainer_agent_graph,
)
from sec_review_agents.agents.memory_maintainer.prompts import (
    MEMORY_MAINTAINER_SYSTEM_PROMPT,
    build_maintenance_prompt,
)
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.path_views import writable_memory_view
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.memory_tree_artifact import DEFAULT_MEMORY_INDEX
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend


@dataclass(frozen=True)
class MemoryMaintenanceResult:
    """Candidate memory tree and invocation trajectory produced by the agent."""

    memory_tree_path: Path
    maintainer_trajectory_path: Path


def _prepare_worktree(
    *,
    base_memory_tree: Path | None,
    observations: list[tuple[str, Path]],
    worktree_root: Path,
) -> list[tuple[str, str]]:
    if not observations:
        raise ValueError("Memory maintenance requires at least one observation.")
    extraction_ids = [extraction_id for extraction_id, _path in observations]
    if len(extraction_ids) != len(set(extraction_ids)):
        raise ValueError("Memory maintenance extraction ids must be unique.")

    if base_memory_tree is None:
        (worktree_root / "topics").mkdir(parents=True)
        (worktree_root / "MEMORY.md").write_text(
            DEFAULT_MEMORY_INDEX,
            encoding="utf-8",
        )
    else:
        resolved_base = base_memory_tree.expanduser().resolve()
        if not (resolved_base / "MEMORY.md").is_file():
            raise ValueError(f"Base memory tree index is missing: {resolved_base}")
        shutil.copytree(resolved_base, worktree_root)

    observations_root = worktree_root / "observations"
    observations_root.mkdir()
    prompt_observations: list[tuple[str, str]] = []
    for index, (extraction_id, path) in enumerate(observations, start=1):
        source = path.expanduser().resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        filename = f"observation-{index:04d}.md"
        shutil.copy2(source, observations_root / filename)
        prompt_observations.append((extraction_id, f"/memory/observations/{filename}"))
    return prompt_observations


async def maintain_memory_tree(
    *,
    base_memory_tree: Path | None,
    observations: list[tuple[str, Path]],
    worktree_root: Path,
    maintainer_trajectory_path: Path,
    deployment: str | None = None,
) -> MemoryMaintenanceResult:
    """Generate a candidate memory tree from explicit immutable inputs."""
    prompt_observations = _prepare_worktree(
        base_memory_tree=base_memory_tree,
        observations=observations,
        worktree_root=worktree_root,
    )
    backend = create_backend_with_path_views(
        container_name_prefix="memory-maintainer",
        path_views=[writable_memory_view(host_path=worktree_root)],
        backend_kind="local",
    )
    model = create_chat_model(
        agent_name=MEMORY_MAINTAINER_AGENT_NAME,
        deployment_override=deployment,
    )
    async with amanaged_backend(backend):
        agent = await create_memory_maintainer_agent_graph(
            model=model,
            backend=backend,
            worktree_root=worktree_root,
        )
        await invoke_agent_runtime_graph(
            agent=agent,
            agent_name=MEMORY_MAINTAINER_AGENT_NAME,
            system_prompt=MEMORY_MAINTAINER_SYSTEM_PROMPT,
            user_prompt=build_maintenance_prompt(prompt_observations),
            trajectory_paths=(maintainer_trajectory_path,),
        )
    return MemoryMaintenanceResult(
        memory_tree_path=worktree_root,
        maintainer_trajectory_path=maintainer_trajectory_path,
    )


__all__ = [
    "MemoryMaintenanceResult",
    "maintain_memory_tree",
]
