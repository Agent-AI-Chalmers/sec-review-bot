"""Run maintenance against catalog-coordinated memory state."""

import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

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
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.path_views import writable_memory_view
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.catalog_client import MemoryCatalogClient
from sec_review_agents.memory.local_store import DEFAULT_MEMORY_INDEX
from sec_review_agents.memory.memory_tree_artifact import (
    materialize_memory_tree,
    publish_memory_tree_artifact,
)
from sec_review_agents.memory.transcript_artifact import (
    publish_memory_agent_transcript,
)
from sec_review_agents.memory.transcripts import memory_agent_transcript_path
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend


async def prepare_coordinated_memory_revision(
    *,
    catalog_client: MemoryCatalogClient,
    maintenance_id: str,
    batch_size: int,
    deployment: str | None = None,
) -> dict[str, object] | None:
    """Run the maintainer and publish immutable inputs for a later revision commit."""
    maintenance_input = catalog_client.get_maintenance_input(limit=batch_size)
    if maintenance_input is None:
        return None
    observations = maintenance_input.get("observations")
    if not isinstance(observations, list) or not observations:
        raise RuntimeError("Catalog maintenance input has no observations.")

    with tempfile.TemporaryDirectory(
        prefix="sec-review-coordinated-memory-maintainer-"
    ) as tempdir:
        temp_root = Path(tempdir)
        worktree_root = temp_root / "memory"
        active_memory_tree_reference = maintenance_input.get(
            "active_memory_tree_reference"
        )
        if isinstance(active_memory_tree_reference, dict):
            active_reference = ArtifactReference.from_mapping(
                active_memory_tree_reference
            )
            if urlparse(active_reference.uri).scheme != "s3":
                raise ValueError(
                    "Catalog active memory must use an S3 artifact reference."
                )
            materialized = materialize_memory_tree(
                active_reference,
                destination=temp_root / "active-memory-tree",
            )
            shutil.copytree(materialized, worktree_root)
        else:
            (worktree_root / "topics").mkdir(parents=True)
            (worktree_root / "MEMORY.md").write_text(
                DEFAULT_MEMORY_INDEX,
                encoding="utf-8",
            )

        observations_root = worktree_root / "observations"
        observations_root.mkdir()
        prompt_observations: list[MemoryMaintenanceObservation] = []
        extraction_ids: list[str] = []
        for index, item in enumerate(observations, start=1):
            if not isinstance(item, dict):
                raise ValueError("Catalog observation must be an object.")
            extraction_id = str(item["extraction_id"])
            extraction_ids.append(extraction_id)
            body = str(item["body_markdown"])
            filename = f"observation-{index:04d}.md"
            (observations_root / filename).write_text(body, encoding="utf-8")
            prompt_observations.append(
                MemoryMaintenanceObservation(
                    extraction_id=extraction_id,
                    mounted_path=f"/memory/observations/{filename}",
                )
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
        base_revision = int(maintenance_input["base_revision"])
        maintenance_transcript_path = memory_agent_transcript_path(
            temp_root / "memory-agent-transcripts",
            agent_name=MEMORY_MAINTAINER_AGENT_NAME,
            run_label=maintenance_id,
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
                transcript_paths=(maintenance_transcript_path,),
            )

        maintenance_transcript_reference = publish_memory_agent_transcript(
            agent_name=MEMORY_MAINTAINER_AGENT_NAME,
            transcript_path=maintenance_transcript_path,
            output_dir=temp_root / "published-transcripts",
        )
        if urlparse(maintenance_transcript_reference.uri).scheme != "s3":
            raise RuntimeError(
                "Maintenance transcript publication requires configured S3 storage."
            )
        memory_tree_reference = publish_memory_tree_artifact(
            memory_content_root=worktree_root,
            output_dir=temp_root / "published",
        )
        if urlparse(memory_tree_reference.uri).scheme != "s3":
            raise RuntimeError(
                "Coordinated memory publication requires configured S3 storage."
            )
    return {
        "maintenance_id": maintenance_id,
        "base_revision": base_revision,
        "extraction_ids": extraction_ids,
        "memory_tree_reference": memory_tree_reference.as_dict(),
        "maintenance_transcript_reference": maintenance_transcript_reference.as_dict(),
    }


__all__ = ["prepare_coordinated_memory_revision"]
