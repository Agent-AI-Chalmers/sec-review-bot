"""Publish the authoritative execution archive from a Temporal activity."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from temporalio import activity
from temporalio.exceptions import ApplicationError

from sec_review_agents.artifacts.reference import (
    ARCHIVE_MEDIA_TYPE,
    require_artifact_media_type,
)
from sec_review_agents.artifacts.uri import (
    parse_artifact_uri,
    parse_local_artifact_uri,
    parse_s3_artifact_uri,
)
from sec_review_agents.execution_archives.models import ExecutionArchive


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
) -> ExecutionArchive:
    from sec_review_agents.execution_archives.bundle import (
        EXECUTION_ARCHIVE_FILENAME,
        ArchiveReviewUnit,
        execution_archive_s3_key,
        publish_execution_archive,
    )

    units = [
        ArchiveReviewUnit(
            unit_id=unit["unit_id"],
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

    # Both newly uploaded and recovered publications pass through this boundary.
    # Only invalid publication metadata is non-retryable; storage failures retain
    # the activity's normal retry policy.
    try:
        reference = publication.reference
        require_artifact_media_type(reference, ARCHIVE_MEDIA_TYPE)
        uri = parse_artifact_uri(reference.uri)
        if uri.scheme != request.destination_scheme:
            raise ValueError(
                "Execution archive URI does not match publication destination."
            )
        if request.destination_scheme == "s3":
            parse_s3_artifact_uri(reference.uri)
            if uri.path != f"/{execution_archive_s3_key(request.run_id)}":
                raise ValueError("Execution archive URI does not belong to the run.")
        elif request.destination_scheme == "file":
            expected = (
                Path(request.artifact_root_path).resolve()
                / "published"
                / EXECUTION_ARCHIVE_FILENAME
            )
            if parse_local_artifact_uri(reference.uri) != expected:
                raise ValueError(
                    "Execution archive URI does not match the local publication path."
                )
        else:
            raise ValueError("Unsupported execution archive publication destination.")
        if reference.size_bytes > 2**53 - 1:
            raise ValueError(
                "Execution archive size exceeds the public JSON integer range."
            )
    except ValueError as error:
        raise ApplicationError(
            str(error), type="ARTIFACT_REFERENCE_INVALID", non_retryable=True
        ) from error
    return publication


__all__ = [
    "ExecutionArchivePublicationRequest",
    "publish_execution_archive_activity",
]
