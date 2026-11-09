"""Publish the authoritative execution archive from a Temporal activity."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from temporalio import activity


@dataclass(frozen=True)
class ExecutionArchivePublicationRequest:
    run_id: str
    artifact_root_path: str
    review_units: list[dict[str, str]]
    result: dict[str, Any]
    destination_scheme: Literal["file", "s3"]


@activity.defn
def publish_execution_archive_activity(
    request: ExecutionArchivePublicationRequest,
) -> dict[str, Any]:
    from sec_review_agents.execution_archives.bundle import (
        ArchiveReviewUnit,
        publish_execution_archive,
    )

    units = [
        ArchiveReviewUnit(
            unit_id=str(unit["unit_id"]),
            trajectory_root=Path(unit["trajectory_root"]),
        )
        for unit in request.review_units
    ]
    publication = publish_execution_archive(
        run_id=request.run_id,
        artifact_root=Path(request.artifact_root_path),
        review_units=units,
        result=request.result,
        destination_scheme=request.destination_scheme,
    )
    reference = publication.reference
    return {
        "artifact_storage": {
            "status": "available",
            "artifact": {
                "kind": "execution_archive",
                **reference.as_dict(),
            },
        },
        "execution_archive": reference.as_dict(),
        "unit_ids": list(publication.unit_ids),
    }


__all__ = [
    "ExecutionArchivePublicationRequest",
    "publish_execution_archive_activity",
]
