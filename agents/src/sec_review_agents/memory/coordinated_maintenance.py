"""Run maintenance against catalog-coordinated memory state."""

import tempfile
from pathlib import Path
from urllib.parse import urlparse

from sec_review_agents.agents.memory_maintainer.agent import (
    MEMORY_MAINTAINER_AGENT_NAME,
)
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.memory.catalog_client import MemoryCatalogClient
from sec_review_agents.memory.maintainer import (
    MemoryMaintenanceInput,
    maintain_memory_tree,
)
from sec_review_agents.memory.memory_tree_artifact import (
    materialize_memory_tree,
    publish_memory_tree_artifact,
)
from sec_review_agents.memory.revision_creation import MemoryTreeRevisionCreation
from sec_review_agents.memory.transcript_artifact import (
    publish_memory_agent_transcript,
)
from sec_review_agents.runtime.transcripts import transcript_path


async def prepare_coordinated_memory_revision(
    *,
    catalog_client: MemoryCatalogClient,
    maintenance_id: str,
    batch_size: int,
    deployment: str | None = None,
) -> MemoryTreeRevisionCreation | None:
    """Run the maintainer and publish immutable inputs for a later revision commit."""
    maintenance_input = catalog_client.get_maintenance_input(limit=batch_size)
    if maintenance_input is None:
        return None

    base_revision = maintenance_input.get("base_revision")
    if (
        not isinstance(base_revision, int)
        or isinstance(base_revision, bool)
        or base_revision < 0
    ):
        raise ValueError("Catalog base revision must be a non-negative integer.")
    if "active_memory_tree_reference" not in maintenance_input:
        raise ValueError("Catalog maintenance input is missing active memory.")
    active_memory_tree_reference = maintenance_input["active_memory_tree_reference"]
    if active_memory_tree_reference is not None and not isinstance(
        active_memory_tree_reference, dict
    ):
        raise ValueError("Catalog active memory reference must be an object or null.")
    if (base_revision == 0) != (active_memory_tree_reference is None):
        raise ValueError(
            "Catalog active memory reference must be null exactly at revision 0."
        )

    observations = maintenance_input.get("observations")
    if not isinstance(observations, list) or not observations:
        raise RuntimeError("Catalog maintenance input has no observations.")

    with tempfile.TemporaryDirectory(
        prefix="sec-review-coordinated-memory-maintainer-"
    ) as tempdir:
        temp_root = Path(tempdir)
        base_memory_tree: Path | None = None
        if isinstance(active_memory_tree_reference, dict):
            active_reference = ArtifactReference.from_mapping(
                active_memory_tree_reference
            )
            if urlparse(active_reference.uri).scheme != "s3":
                raise ValueError(
                    "Catalog active memory must use an S3 artifact reference."
                )
            base_memory_tree = materialize_memory_tree(
                active_reference,
                destination=temp_root / "active-memory-tree",
            )

        observations_root = temp_root / "observations"
        observations_root.mkdir()
        maintenance_observations: list[MemoryMaintenanceInput] = []
        extraction_ids: list[str] = []
        for index, item in enumerate(observations, start=1):
            if not isinstance(item, dict):
                raise ValueError("Catalog observation must be an object.")
            extraction_id = item.get("extraction_id")
            if not isinstance(extraction_id, str) or not extraction_id:
                raise ValueError(
                    "Catalog observation extraction_id must be a non-empty string."
                )
            extraction_ids.append(extraction_id)
            body = item.get("body_markdown")
            if not isinstance(body, str) or not body:
                raise ValueError(
                    "Catalog observation body_markdown must be a non-empty string."
                )
            filename = f"observation-{index:04d}.md"
            (observations_root / filename).write_text(body, encoding="utf-8")
            maintenance_observations.append(
                MemoryMaintenanceInput(
                    extraction_id=extraction_id,
                    path=observations_root / filename,
                )
            )

        maintainer_transcript_path = transcript_path(
            temp_root / "memory-agent-transcripts",
            name="maintainer",
        )
        result = await maintain_memory_tree(
            base_memory_tree=base_memory_tree,
            observations=maintenance_observations,
            worktree_root=temp_root / "candidate-memory-tree",
            maintainer_transcript_path=maintainer_transcript_path,
            deployment=deployment,
        )

        maintenance_transcript_reference = publish_memory_agent_transcript(
            agent_name=MEMORY_MAINTAINER_AGENT_NAME,
            transcript_path=result.maintainer_transcript_path,
            output_dir=temp_root / "published-transcripts",
        )
        if urlparse(maintenance_transcript_reference.uri).scheme != "s3":
            raise RuntimeError(
                "Maintenance transcript publication requires configured S3 storage."
            )
        memory_tree_reference = publish_memory_tree_artifact(
            memory_content_root=result.memory_tree_path,
            output_dir=temp_root / "published",
        )
        if urlparse(memory_tree_reference.uri).scheme != "s3":
            raise RuntimeError(
                "Coordinated memory publication requires configured S3 storage."
            )
    return MemoryTreeRevisionCreation(
        maintenance_id=maintenance_id,
        base_revision=base_revision,
        extraction_ids=tuple(extraction_ids),
        memory_tree_reference=memory_tree_reference,
        maintenance_transcript_reference=maintenance_transcript_reference,
    )


__all__ = ["MemoryTreeRevisionCreation", "prepare_coordinated_memory_revision"]
