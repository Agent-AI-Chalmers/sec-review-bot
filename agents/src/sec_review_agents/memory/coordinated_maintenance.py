"""Run maintenance against catalog-coordinated memory state."""

import tempfile
from pathlib import Path
from urllib.parse import urlparse

from sec_review_agents.agents.memory_maintainer.agent import (
    MEMORY_MAINTAINER_AGENT_NAME,
)
from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.artifacts.s3_adapter import (
    planned_s3_artifact,
    publish_immutable_s3_artifact,
    s3_artifact_exists,
)
from sec_review_agents.memory.catalog_client import MemoryCatalogClient
from sec_review_agents.memory.maintainer import maintain_memory_tree
from sec_review_agents.memory.memory_tree_artifact import (
    build_memory_tree_artifact,
    materialize_memory_tree,
    memory_tree_artifact_s3_key,
)
from sec_review_agents.memory.revision_commit_input import (
    MemoryTreeRevisionCommitInput,
)
from sec_review_agents.memory.trajectory_artifact import (
    build_memory_agent_trajectory,
    memory_agent_trajectory_s3_key,
)
from sec_review_agents.runtime.trajectories import trajectory_path


async def prepare_coordinated_memory_revision(
    *,
    catalog_client: MemoryCatalogClient,
    maintenance_id: str,
    batch_size: int,
    deployment: str | None = None,
) -> MemoryTreeRevisionCommitInput | None:
    """Run the maintainer and publish immutable inputs for a later revision commit."""
    for publication in catalog_client.list_revision_publications(maintenance_id):
        intent = publication["intent"]
        if all(
            s3_artifact_exists(ArtifactReference.from_mapping(value))
            for value in (
                intent["memory_tree_reference"],
                intent["source"]["trajectory_reference"],
            )
        ):
            catalog_client.confirm_revision_publication(intent)
            return MemoryTreeRevisionCommitInput(
                maintenance_id=maintenance_id,
                expected_active_revision=intent["expected_active_revision"],
                extraction_ids=tuple(intent["source"]["extraction_ids"]),
                memory_tree_reference=ArtifactReference.from_mapping(
                    intent["memory_tree_reference"]
                ),
                maintenance_trajectory_reference=ArtifactReference.from_mapping(
                    intent["source"]["trajectory_reference"]
                ),
            )
        if publication["status"] == "selected":
            raise RuntimeError(
                "Selected memory revision publication artifact is missing."
            )
    maintenance_input = catalog_client.get_maintenance_input(limit=batch_size)
    if maintenance_input is None:
        return None

    expected_active_revision = maintenance_input.get("expected_active_revision")
    if (
        not isinstance(expected_active_revision, int)
        or isinstance(expected_active_revision, bool)
        or expected_active_revision < 0
    ):
        raise ValueError(
            "Catalog expected active revision must be a non-negative integer."
        )
    if "active_memory_tree_reference" not in maintenance_input:
        raise ValueError("Catalog maintenance input is missing active memory.")
    active_memory_tree_reference = maintenance_input["active_memory_tree_reference"]
    if active_memory_tree_reference is not None and not isinstance(
        active_memory_tree_reference, dict
    ):
        raise ValueError("Catalog active memory reference must be an object or null.")
    if (expected_active_revision == 0) != (active_memory_tree_reference is None):
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
        maintenance_observations: list[tuple[str, Path]] = []
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
                (extraction_id, observations_root / filename)
            )

        maintainer_trajectory_path = trajectory_path(
            temp_root / "memory-agent-trajectories",
            name="maintainer",
        )
        result = await maintain_memory_tree(
            base_memory_tree=base_memory_tree,
            observations=maintenance_observations,
            worktree_root=temp_root / "candidate-memory-tree",
            maintainer_trajectory_path=maintainer_trajectory_path,
            deployment=deployment,
        )

        trajectory = build_memory_agent_trajectory(
            trajectory_path=result.maintainer_trajectory_path,
            output_dir=temp_root / "published-trajectories",
        )
        tree = build_memory_tree_artifact(
            memory_content_root=result.memory_tree_path,
            output_dir=temp_root / "published",
        )
        trajectory_key = memory_agent_trajectory_s3_key(
            agent_name=MEMORY_MAINTAINER_AGENT_NAME, digest=trajectory.digest
        )
        tree_key = memory_tree_artifact_s3_key(tree.digest)
        maintenance_trajectory_reference = planned_s3_artifact(
            trajectory, key=trajectory_key
        )
        memory_tree_reference = planned_s3_artifact(tree, key=tree_key)
        intent = {
            "expected_active_revision": expected_active_revision,
            "memory_tree_reference": memory_tree_reference.as_dict(),
            "source": {
                "kind": "maintenance",
                "maintenance_id": maintenance_id,
                "extraction_ids": extraction_ids,
                "trajectory_reference": maintenance_trajectory_reference.as_dict(),
            },
        }
        catalog_client.reserve_revision_publication(intent)
        publish_immutable_s3_artifact(
            trajectory, key=trajectory_key, description="maintenance trajectory"
        )
        publish_immutable_s3_artifact(tree, key=tree_key, description="memory tree")
        catalog_client.confirm_revision_publication(intent)
    return MemoryTreeRevisionCommitInput(
        maintenance_id=maintenance_id,
        expected_active_revision=expected_active_revision,
        extraction_ids=tuple(extraction_ids),
        memory_tree_reference=memory_tree_reference,
        maintenance_trajectory_reference=maintenance_trajectory_reference,
    )


__all__ = ["prepare_coordinated_memory_revision"]
