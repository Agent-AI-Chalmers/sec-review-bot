from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.discovery.agent import (
    DISCOVERY_AGENT_NAME,
    create_repository_discovery_agent_graph,
)
from sec_review_agents.agents.discovery.backend import (
    create_repository_discovery_backend,
)
from sec_review_agents.agents.discovery.prompts import (
    build_repository_discovery_system_prompt,
    build_repository_discovery_user_prompt,
)
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import managed_backend


async def run_repository_discovery_agent(
    *,
    chunk: Mapping[str, Any],
    sources: Mapping[str, str],
    discovery_artifacts_path: Path | None = None,
) -> dict:
    chunk_id = str((chunk or {}).get("chunk_id") or "").strip()
    transcript_paths = (
        (discovery_artifacts_path / "transcripts" / f"{chunk_id}.jsonl",)
        if discovery_artifacts_path
        else ()
    )

    backend = create_repository_discovery_backend()
    with managed_backend(backend):
        agent = await create_repository_discovery_agent_graph(
            backend=backend,
            chunk=chunk,
        )
        structured_payload = await invoke_agent_runtime_graph(
            agent=agent,
            agent_name=DISCOVERY_AGENT_NAME,
            system_prompt=build_repository_discovery_system_prompt(),
            user_prompt=build_repository_discovery_user_prompt(
                chunk=chunk,
                sources=sources,
            ),
            transcript_paths=transcript_paths,
        )

    candidates = structured_payload.get("candidates")
    if not isinstance(candidates, list):
        candidates = []
    return {
        "candidates": [item for item in candidates if isinstance(item, dict)],
    }
