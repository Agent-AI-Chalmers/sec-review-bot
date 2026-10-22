import hashlib
import tempfile
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from temporalio import activity, workflow
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.temporal.support import activity_retry_policy


@dataclass(frozen=True)
class MemoryExtractionRequest:
    """Extract durable memory from one unit in an immutable transcript bundle."""

    source_workflow: str
    run_id: str
    review_unit_id: str
    transcript_bundle: dict[str, Any]
    timeout_seconds: int


@dataclass(frozen=True)
class TranscriptBundlePublicationRequest:
    run_id: str
    artifact_root_path: str
    review_units: list[dict[str, str]]
    timeout_seconds: int


def memory_extraction_workflow_id(
    *,
    transcript_digest: str,
    review_unit_id: str,
) -> str:
    """Return the stable Temporal identity for one transcript unit."""
    identity = f"{transcript_digest}\0{review_unit_id}".encode()
    return f"memory-extraction:{hashlib.sha256(identity).hexdigest()}"


async def publish_and_start_memory_extractions(
    request: TranscriptBundlePublicationRequest,
    *,
    source_workflow: str,
    start_extractions: bool,
) -> dict[str, Any]:
    """Publish one run bundle and start independent extraction workflows.

    Transcript publication and memory extraction are post-processing: failures
    are returned as workflow metadata and do not change the review result.
    """
    try:
        published = await workflow.execute_activity(
            publish_transcript_bundle_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
    except Exception as error:
        workflow.logger.warning(
            "Failed to publish transcript bundle for %s: %s",
            request.run_id,
            error,
        )
        return {
            "transcript_publication": "failed",
            "extractions": [],
            "error_code": "TRANSCRIPT_PUBLICATION_FAILED",
        }

    transcript_bundle = dict(published["transcript_bundle"])
    result: dict[str, Any] = {
        "transcript_publication": "published",
        "extractions": [],
    }
    if not start_extractions:
        return result

    digest = str(transcript_bundle["digest"])
    for review_unit_id_value in published["review_unit_ids"]:
        review_unit_id = str(review_unit_id_value)
        extraction_id = memory_extraction_workflow_id(
            transcript_digest=digest,
            review_unit_id=review_unit_id,
        )
        extraction = {
            "review_unit_id": review_unit_id,
            "workflow_id": extraction_id,
        }
        try:
            await workflow.start_child_workflow(
                MemoryExtractionWorkflow.run,
                MemoryExtractionRequest(
                    source_workflow=source_workflow,
                    run_id=request.run_id,
                    review_unit_id=review_unit_id,
                    transcript_bundle=transcript_bundle,
                    timeout_seconds=request.timeout_seconds,
                ),
                id=extraction_id,
                parent_close_policy=workflow.ParentClosePolicy.ABANDON,
                id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE,
            )
            extraction["status"] = "started"
        except WorkflowAlreadyStartedError:
            extraction["status"] = "already_started"
        except Exception as error:
            workflow.logger.warning(
                "Failed to start memory extraction %s: %s",
                extraction_id,
                error,
            )
            extraction["status"] = "start_failed"
            extraction["error_code"] = "MEMORY_EXTRACTION_START_FAILED"
        result["extractions"].append(extraction)
    return result


@activity.defn
def publish_transcript_bundle_activity(
    request: TranscriptBundlePublicationRequest,
) -> dict[str, Any]:
    from sec_review_agents.memory.transcript_bundle import (
        TranscriptReviewUnit,
        publish_transcript_bundle,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    units = [
        TranscriptReviewUnit(
            review_unit_id=str(unit["review_unit_id"]),
            transcript_root=Path(unit["transcript_root"]),
        )
        for unit in request.review_units
    ]
    reference = publish_transcript_bundle(
        run_id=request.run_id,
        artifact_root=Path(request.artifact_root_path),
        review_units=units,
    )
    included_ids = [
        unit.review_unit_id
        for unit in units
        if list(unit.transcript_root.glob("*.jsonl"))
    ]
    return {
        "transcript_bundle": reference.as_dict(),
        "review_unit_ids": included_ids,
    }


async def run_memory_extraction(
    request: MemoryExtractionRequest,
    *,
    deployment: str | None = None,
) -> dict[str, Any]:
    from sec_review_agents.agents.memory_extractor.agent import (
        MEMORY_EXTRACTOR_AGENT_NAME,
    )
    from sec_review_agents.artifacts.reference import ArtifactReference
    from sec_review_agents.memory.audit_bundle import publish_memory_audit_bundle
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.memory.extractor import (
        extract_memory_observations_from_paths,
        preview_memory_observation_from_paths,
    )
    from sec_review_agents.memory.store import resolve_memory_store_dir
    from sec_review_agents.memory.transcript_bundle import materialize_transcript_unit

    reference = ArtifactReference.from_mapping(request.transcript_bundle)
    extraction_id = memory_extraction_workflow_id(
        transcript_digest=reference.digest,
        review_unit_id=request.review_unit_id,
    )
    catalog_client = configured_memory_catalog_client()
    with tempfile.TemporaryDirectory(prefix="sec-review-extraction-input-") as tempdir:
        temp_root = Path(tempdir)
        materialized = materialize_transcript_unit(
            reference,
            run_id=request.run_id,
            review_unit_id=request.review_unit_id,
            destination=temp_root / "transcript-bundle",
        )
        if catalog_client is None:
            memory_store_dir = resolve_memory_store_dir(None, required=True)
            assert memory_store_dir is not None
            result = await extract_memory_observations_from_paths(
                list(materialized.transcript_paths),
                memory_store_dir=memory_store_dir,
                deployment=deployment,
                job_id=extraction_id,
                source_workflow=request.source_workflow,
                run_id=request.run_id,
            )
            return {
                "ok": True,
                "skipped": result.skipped,
                "summary": result.summary,
                "observation_paths": [str(path) for path in result.observation_paths],
                "extraction_id": extraction_id,
            }

        audit_root = temp_root / "audit"
        preview = await preview_memory_observation_from_paths(
            list(materialized.transcript_paths),
            deployment=deployment,
            observation_id_value=extraction_id,
            job_id=extraction_id,
            source_workflow=request.source_workflow,
            run_id=request.run_id,
            audit_root=audit_root,
        )
        audit_reference = publish_memory_audit_bundle(
            agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
            transcript_paths=sorted(audit_root.rglob("*.jsonl")),
            output_dir=temp_root / "published-audit",
        )
        if preview.observation_markdown is not None:
            catalog_client.register_observation(
                observation_id=preview.observation_id,
                source_workflow=request.source_workflow,
                source_run_id=request.run_id,
                source_review_unit_id=request.review_unit_id,
                transcript_digest=reference.digest,
                body_markdown=preview.observation_markdown,
                audit_reference=audit_reference,
            )
        return {
            "ok": True,
            "skipped": preview.skipped,
            "summary": preview.summary,
            "observation_id": (
                preview.observation_id
                if preview.observation_markdown is not None
                else None
            ),
            "audit_reference": audit_reference.as_dict(),
            "extraction_id": extraction_id,
        }


@activity.defn
async def run_memory_extraction_activity(
    request: MemoryExtractionRequest,
) -> dict[str, Any]:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import MemoryCatalogConflictError
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    try:
        return await run_memory_extraction(request)
    except MemoryCatalogConflictError as error:
        raise ApplicationError(
            str(error),
            type="MEMORY_CATALOG_OBSERVATION_CONFLICT",
            non_retryable=True,
        ) from error


@workflow.defn
class MemoryExtractionWorkflow:
    @workflow.run
    async def run(self, request: MemoryExtractionRequest) -> dict[str, Any]:
        return await workflow.execute_activity(
            run_memory_extraction_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )


__all__ = [
    "MemoryExtractionRequest",
    "MemoryExtractionWorkflow",
    "TranscriptBundlePublicationRequest",
    "memory_extraction_workflow_id",
    "publish_and_start_memory_extractions",
    "publish_transcript_bundle_activity",
    "run_memory_extraction",
    "run_memory_extraction_activity",
]
