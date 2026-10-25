"""Carry immutable inputs from memory maintenance to the Catalog commit.

Maintenance has already produced and published the candidate memory tree and
its transcript when this value is created. The Catalog has not yet assigned a
revision number or advanced the active revision. Temporal persists this value
between the preparation and commit activities so commit retries reuse the same
artifacts, extraction IDs, and base revision.
"""

from dataclasses import dataclass

from sec_review_agents.artifacts.reference import ArtifactReference


@dataclass(frozen=True)
class MemoryTreeRevisionCreation:
    """Immutable input for creating a memory-tree revision in the Catalog."""

    maintenance_id: str
    base_revision: int
    extraction_ids: tuple[str, ...]
    memory_tree_reference: ArtifactReference
    maintenance_transcript_reference: ArtifactReference

    def __post_init__(self) -> None:
        if not isinstance(self.maintenance_id, str) or not self.maintenance_id.strip():
            raise ValueError(
                "Memory tree revision creation maintenance_id must be non-empty."
            )
        if (
            not isinstance(self.base_revision, int)
            or isinstance(self.base_revision, bool)
            or self.base_revision < 0
        ):
            raise ValueError(
                "Memory tree revision creation base_revision must be non-negative."
            )
        if (
            not isinstance(self.extraction_ids, tuple)
            or not self.extraction_ids
            or any(
                not isinstance(extraction_id, str) or not extraction_id.strip()
                for extraction_id in self.extraction_ids
            )
        ):
            raise ValueError(
                "Memory tree revision creation extraction_ids must be non-empty strings."
            )
        if len(set(self.extraction_ids)) != len(self.extraction_ids):
            raise ValueError(
                "Memory tree revision creation extraction_ids must be unique."
            )
        if not isinstance(self.memory_tree_reference, ArtifactReference):
            raise TypeError("Memory tree revision creation tree reference is invalid.")
        if not isinstance(self.maintenance_transcript_reference, ArtifactReference):
            raise TypeError(
                "Memory tree revision creation maintenance transcript reference is invalid."
            )


__all__ = ["MemoryTreeRevisionCreation"]
