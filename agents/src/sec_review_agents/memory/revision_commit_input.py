"""Carry immutable inputs from memory maintenance to the Catalog commit.

Learning or reorganization has already produced and published the candidate
memory tree and its trajectory when this value is created. The Catalog has not
yet assigned a revision number or advanced the active revision. Temporal
persists this value between the preparation and commit activities so commit
retries reuse the same artifacts, extraction IDs, maintenance report, and
expected active revision.
"""

from dataclasses import dataclass
from typing import Literal

from sec_review_agents.agents.memory_maintainer.model import MemoryMaintenanceOutput
from sec_review_agents.artifacts.reference import ArtifactReference


@dataclass(frozen=True)
class MemoryTreeRevisionCommitInput:
    """Immutable input for committing a memory-tree revision to the Catalog."""

    operation_id: str
    expected_active_revision: int
    observation_ids: tuple[str, ...]
    memory_tree_reference: ArtifactReference
    trajectory_reference: ArtifactReference
    maintenance_report: MemoryMaintenanceOutput
    source_kind: Literal["learning", "reorganization"] = "learning"

    def __post_init__(self) -> None:
        if not isinstance(self.operation_id, str) or not self.operation_id.strip():
            raise ValueError(
                "Memory tree revision commit input operation_id must be non-empty."
            )
        if (
            not isinstance(self.expected_active_revision, int)
            or isinstance(self.expected_active_revision, bool)
            or self.expected_active_revision < 0
        ):
            raise ValueError(
                "Memory tree revision commit input expected_active_revision must be non-negative."
            )
        if self.source_kind not in {"learning", "reorganization"}:
            raise ValueError(
                "Memory tree revision commit input source_kind is invalid."
            )
        if not isinstance(self.observation_ids, tuple):
            raise TypeError(
                "Memory tree revision commit input observation_ids must be a tuple."
            )
        if self.source_kind == "learning" and not self.observation_ids:
            raise ValueError(
                "Learning tree revision commit input observation_ids must be non-empty."
            )
        if self.source_kind == "reorganization" and self.observation_ids:
            raise ValueError(
                "Reorganization tree revision commit input must not consume observations."
            )
        if any(
            not isinstance(observation_id, str) or not observation_id.strip()
            for observation_id in self.observation_ids
        ):
            raise ValueError(
                "Memory tree revision commit input observation_ids must be non-empty strings."
            )
        if len(set(self.observation_ids)) != len(self.observation_ids):
            raise ValueError(
                "Memory tree revision commit input observation_ids must be unique."
            )
        if not isinstance(self.memory_tree_reference, ArtifactReference):
            raise TypeError(
                "Memory tree revision commit input tree reference is invalid."
            )
        if not isinstance(self.trajectory_reference, ArtifactReference):
            raise TypeError(
                "Memory tree revision commit input trajectory reference is invalid."
            )
        if not isinstance(self.maintenance_report, MemoryMaintenanceOutput):
            raise TypeError(
                "Memory tree revision commit input maintenance report is invalid."
            )
        decided = [
            decision.observation_id
            for decision in self.maintenance_report.observation_decisions
        ]
        if sorted(decided) != sorted(self.observation_ids):
            raise ValueError(
                "Memory tree revision commit input maintenance report must decide "
                "each consumed observation exactly once."
            )


__all__ = ["MemoryTreeRevisionCommitInput"]
