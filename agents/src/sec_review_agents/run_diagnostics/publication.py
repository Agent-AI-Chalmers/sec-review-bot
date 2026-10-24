"""Publish the authoritative run diagnostic bundle from a Temporal activity."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from temporalio import activity


@dataclass(frozen=True)
class RunDiagnosticPublicationRequest:
    run_id: str
    artifact_root_path: str
    review_units: list[dict[str, str]]
    result: dict[str, Any]
    publication: Literal["local", "managed"]


@activity.defn
def publish_run_diagnostic_activity(
    request: RunDiagnosticPublicationRequest,
) -> dict[str, Any]:
    from sec_review_agents.run_diagnostics.bundle import (
        DiagnosticReviewUnit,
        publish_run_diagnostic_bundle,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    units = [
        DiagnosticReviewUnit(
            review_unit_id=str(unit["review_unit_id"]),
            transcript_root=Path(unit["transcript_root"]),
        )
        for unit in request.review_units
    ]
    publication = publish_run_diagnostic_bundle(
        run_id=request.run_id,
        artifact_root=Path(request.artifact_root_path),
        review_units=units,
        result=request.result,
        remote=request.publication == "managed",
    )
    reference = publication.reference
    return {
        "artifact_storage": {
            "status": "available",
            "artifact": {
                "kind": "diagnostic_bundle",
                **reference.as_dict(),
            },
        },
        "diagnostic_bundle": reference.as_dict(),
        "review_unit_ids": list(publication.review_unit_ids),
    }


__all__ = [
    "RunDiagnosticPublicationRequest",
    "publish_run_diagnostic_activity",
]
