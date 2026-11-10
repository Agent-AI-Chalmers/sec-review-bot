"""Run maintenance against catalog-coordinated memory state."""

import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
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
from sec_review_agents.memory.catalog_client import (
    MemoryCatalogClient,
    MemoryPublicationAbandonedError,
)
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

MemoryRevisionSourceKind = Literal["learning", "reorganization"]


@dataclass(frozen=True)
class CoordinatedReorganizationResult:
    """Prepared reorganization revision or the reason reorganization stopped."""

    commit_input: MemoryTreeRevisionCommitInput | None
    summary: str


def _commit_input_from_intent(
    *, operation_id: str, intent: dict[str, Any]
) -> MemoryTreeRevisionCommitInput:
    source = intent.get("source")
    if not isinstance(source, dict):
        raise RuntimeError("Memory revision publication intent has no source.")
    kind = source.get("kind")
    if kind not in {"learning", "reorganization"}:
        raise RuntimeError(
            "Memory revision publication intent is not a maintainer source."
        )
    extraction_ids = source.get("extraction_ids", ())
    if not isinstance(extraction_ids, (list, tuple)):
        raise RuntimeError("Memory revision publication extraction_ids is invalid.")
    return MemoryTreeRevisionCommitInput(
        operation_id=operation_id,
        expected_active_revision=intent["expected_active_revision"],
        extraction_ids=tuple(extraction_ids),
        memory_tree_reference=ArtifactReference.from_mapping(
            intent["memory_tree_reference"]
        ),
        trajectory_reference=ArtifactReference.from_mapping(
            source["trajectory_reference"]
        ),
        source_kind=kind,
    )


def _recover_publication(
    *,
    catalog_client: MemoryCatalogClient,
    operation_id: str,
    source_kind: MemoryRevisionSourceKind,
) -> MemoryTreeRevisionCommitInput | None:
    for publication in catalog_client.list_revision_publications(
        operation_id, kind=source_kind
    ):
        if publication["status"] == "abandoned":
            raise MemoryPublicationAbandonedError(
                "Revision publication has been abandoned."
            )
        intent = publication["intent"]
        if all(
            s3_artifact_exists(ArtifactReference.from_mapping(value))
            for value in (
                intent["memory_tree_reference"],
                intent["source"]["trajectory_reference"],
            )
        ):
            catalog_client.confirm_revision_publication(intent)
            commit_input = _commit_input_from_intent(
                operation_id=operation_id, intent=intent
            )
            if commit_input.source_kind != source_kind:
                raise RuntimeError(
                    "Memory revision publication source kind does not match this run."
                )
            return commit_input
        if publication["status"] == "selected":
            raise RuntimeError(
                "Selected memory revision publication artifact is missing."
            )
    return None


def _publish_candidate(
    *,
    catalog_client: MemoryCatalogClient,
    operation_id: str,
    expected_active_revision: int,
    source_kind: MemoryRevisionSourceKind,
    extraction_ids: tuple[str, ...],
    memory_tree_path: Path,
    maintainer_trajectory_path: Path,
    temp_root: Path,
) -> MemoryTreeRevisionCommitInput:
    trajectory = build_memory_agent_trajectory(
        trajectory_path=maintainer_trajectory_path,
        output_dir=temp_root / "published-trajectories",
    )
    tree = build_memory_tree_artifact(
        memory_content_root=memory_tree_path,
        output_dir=temp_root / "published",
    )
    trajectory_key = memory_agent_trajectory_s3_key(
        agent_name=MEMORY_MAINTAINER_AGENT_NAME, digest=trajectory.digest
    )
    tree_key = memory_tree_artifact_s3_key(tree.digest)
    trajectory_reference = planned_s3_artifact(trajectory, key=trajectory_key)
    memory_tree_reference = planned_s3_artifact(tree, key=tree_key)
    source: dict[str, Any] = {
        "kind": source_kind,
        "operation_id": operation_id,
        "trajectory_reference": trajectory_reference.as_dict(),
    }
    if source_kind == "learning":
        source["extraction_ids"] = list(extraction_ids)
    intent = {
        "expected_active_revision": expected_active_revision,
        "memory_tree_reference": memory_tree_reference.as_dict(),
        "source": source,
    }
    catalog_client.reserve_revision_publication(intent)
    publish_immutable_s3_artifact(
        trajectory, key=trajectory_key, description="maintainer trajectory"
    )
    publish_immutable_s3_artifact(tree, key=tree_key, description="memory tree")
    catalog_client.confirm_revision_publication(intent)
    return MemoryTreeRevisionCommitInput(
        operation_id=operation_id,
        expected_active_revision=expected_active_revision,
        extraction_ids=extraction_ids,
        memory_tree_reference=memory_tree_reference,
        trajectory_reference=trajectory_reference,
        source_kind=source_kind,
    )


async def prepare_coordinated_memory_learning(
    *,
    catalog_client: MemoryCatalogClient,
    operation_id: str,
    batch_size: int,
    deployment: str | None = None,
) -> MemoryTreeRevisionCommitInput | None:
    """Run learning and publish immutable inputs for a later commit."""
    recovered = _recover_publication(
        catalog_client=catalog_client,
        operation_id=operation_id,
        source_kind="learning",
    )
    if recovered is not None:
        return recovered

    learning_input = catalog_client.get_learning_input(limit=batch_size)
    if learning_input is None:
        return None

    expected_active_revision = learning_input.get("expected_active_revision")
    if (
        not isinstance(expected_active_revision, int)
        or isinstance(expected_active_revision, bool)
        or expected_active_revision < 0
    ):
        raise ValueError(
            "Catalog expected active revision must be a non-negative integer."
        )
    if "active_memory_tree_reference" not in learning_input:
        raise ValueError("Catalog learning input is missing active memory.")
    active_memory_tree_reference = learning_input["active_memory_tree_reference"]
    if active_memory_tree_reference is not None and not isinstance(
        active_memory_tree_reference, dict
    ):
        raise ValueError("Catalog active memory reference must be an object or null.")
    if (expected_active_revision == 0) != (active_memory_tree_reference is None):
        raise ValueError(
            "Catalog active memory reference must be null exactly at revision 0."
        )

    observations = learning_input.get("observations")
    if not isinstance(observations, list) or not observations:
        raise RuntimeError("Catalog learning input has no observations.")

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
        return _publish_candidate(
            catalog_client=catalog_client,
            operation_id=operation_id,
            expected_active_revision=expected_active_revision,
            source_kind="learning",
            extraction_ids=tuple(extraction_ids),
            memory_tree_path=result.memory_tree_path,
            maintainer_trajectory_path=result.maintainer_trajectory_path,
            temp_root=temp_root,
        )


async def prepare_coordinated_memory_reorganization(
    *,
    catalog_client: MemoryCatalogClient,
    operation_id: str,
    deployment: str | None = None,
) -> CoordinatedReorganizationResult:
    """Reorganize the active memory without consuming observations."""
    recovered = _recover_publication(
        catalog_client=catalog_client,
        operation_id=operation_id,
        source_kind="reorganization",
    )
    if recovered is not None:
        return CoordinatedReorganizationResult(
            commit_input=recovered,
            summary="Recovered prepared reorganization revision.",
        )

    active_memory = catalog_client.get_memory_tree()
    expected_active_revision = active_memory.get("revision")
    if (
        not isinstance(expected_active_revision, int)
        or isinstance(expected_active_revision, bool)
        or expected_active_revision < 1
    ):
        return CoordinatedReorganizationResult(
            commit_input=None,
            summary="No active memory to reorganize.",
        )
    active_memory_tree_reference = active_memory.get("memory_tree_reference")
    if not isinstance(active_memory_tree_reference, dict):
        return CoordinatedReorganizationResult(
            commit_input=None,
            summary="No active memory to reorganize.",
        )
    active_reference = ArtifactReference.from_mapping(active_memory_tree_reference)
    if urlparse(active_reference.uri).scheme != "s3":
        raise ValueError("Catalog active memory must use an S3 artifact reference.")

    with tempfile.TemporaryDirectory(
        prefix="sec-review-coordinated-memory-reorganization-"
    ) as tempdir:
        temp_root = Path(tempdir)
        active_memory_tree = materialize_memory_tree(
            active_reference,
            destination=temp_root / "active-memory-tree",
        )
        if not any((active_memory_tree / "topics").rglob("*.md")):
            return CoordinatedReorganizationResult(
                commit_input=None,
                summary="Active memory has no topics to reorganize.",
            )

        maintainer_trajectory_path = trajectory_path(
            temp_root / "memory-agent-trajectories",
            name="maintainer",
        )
        result = await maintain_memory_tree(
            base_memory_tree=active_memory_tree,
            observations=[],
            worktree_root=temp_root / "candidate-memory-tree",
            maintainer_trajectory_path=maintainer_trajectory_path,
            deployment=deployment,
            reorganization=True,
        )
        candidate_tree = build_memory_tree_artifact(
            memory_content_root=result.memory_tree_path,
            output_dir=temp_root / "candidate-check",
        )
        if candidate_tree.digest == active_reference.digest:
            return CoordinatedReorganizationResult(
                commit_input=None,
                summary="Reorganization produced no memory changes.",
            )
        commit_input = _publish_candidate(
            catalog_client=catalog_client,
            operation_id=operation_id,
            expected_active_revision=expected_active_revision,
            source_kind="reorganization",
            extraction_ids=(),
            memory_tree_path=result.memory_tree_path,
            maintainer_trajectory_path=result.maintainer_trajectory_path,
            temp_root=temp_root,
        )
        return CoordinatedReorganizationResult(
            commit_input=commit_input,
            summary="Prepared reorganization revision.",
        )


__all__ = [
    "CoordinatedReorganizationResult",
    "prepare_coordinated_memory_learning",
    "prepare_coordinated_memory_reorganization",
]
