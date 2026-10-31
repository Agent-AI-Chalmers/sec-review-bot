from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.discovery.agent import (
    run_repository_discovery_agent as run_discovery_agent,
)
from sec_review_agents.agents.discovery.backend import (
    create_repository_discovery_backend,
)
from sec_review_agents.agents.discovery.prompts import (
    build_repository_discovery_user_prompt,
)
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.trajectories import trajectory_path


async def run_repository_discovery_agent(
    *,
    chunk: Mapping[str, Any],
    sources: Mapping[str, str],
    discovery_artifacts_path: Path | None = None,
) -> dict:
    chunk_id = str((chunk or {}).get("chunk_id") or "").strip()
    trajectory_paths = (
        (
            trajectory_path(
                discovery_artifacts_path / "trajectories",
                name=chunk_id,
            ),
        )
        if discovery_artifacts_path
        else ()
    )

    backend = create_repository_discovery_backend()
    async with amanaged_backend(backend):
        structured_payload = (
            await run_discovery_agent(
                backend=backend,
                chunk=chunk,
                user_prompt=build_repository_discovery_user_prompt(
                    chunk=chunk,
                    sources=sources,
                ),
                trajectory_paths=trajectory_paths,
            )
        ).model_dump(by_alias=True)

    candidates = structured_payload.get("candidates")
    if not isinstance(candidates, list):
        candidates = []
    return {
        "candidates": [item for item in candidates if isinstance(item, dict)],
    }
