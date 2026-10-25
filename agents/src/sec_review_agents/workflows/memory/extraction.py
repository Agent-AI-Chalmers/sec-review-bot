import hashlib
import tempfile
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.temporal.support import activity_retry_policy


@dataclass(frozen=True)
class MemoryExtractionRequest:
    """Extract durable memory from one unit in an immutable run diagnostic."""

    source_workflow: str
    run_id: str
    review_unit_id: str
    diagnostic_bundle: dict[str, Any]
    timeout_seconds: int


def memory_extraction_workflow_id(
    *,
    diagnostic_bundle_digest: str,
    review_unit_id: str,
) -> str:
    """Return the stable Temporal identity for one transcript unit."""
    identity = f"{diagnostic_bundle_digest}\0{review_unit_id}".encode()
    return f"memory-extraction:{hashlib.sha256(identity).hexdigest()}"


async def run_memory_extraction(
    request: MemoryExtractionRequest,
    *,
    deployment: str | None = None,
) -> dict[str, Any]:
    from sec_review_agents.agents.memory_extractor.agent import (
        MEMORY_EXTRACTOR_AGENT_NAME,
    )
    from sec_review_agents.artifacts.reference import ArtifactReference
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.memory.extractor import (
        extract_memory_observations_from_paths,
        preview_memory_observation_from_paths,
    )
    from sec_review_agents.memory.local_store import resolve_memory_store_dir
    from sec_review_agents.memory.transcript_artifact import (
        publish_memory_agent_transcript,
    )
    from sec_review_agents.run_diagnostics.bundle import (
        materialize_diagnostic_transcript_unit,
    )

    reference = ArtifactReference.from_mapping(request.diagnostic_bundle)
    extraction_id = memory_extraction_workflow_id(
        diagnostic_bundle_digest=reference.digest,
        review_unit_id=request.review_unit_id,
    )
    catalog_client = configured_memory_catalog_client()
    with tempfile.TemporaryDirectory(prefix="sec-review-extraction-input-") as tempdir:
        temp_root = Path(tempdir)
        materialized = materialize_diagnostic_transcript_unit(
            reference,
            run_id=request.run_id,
            review_unit_id=request.review_unit_id,
            destination=temp_root / "diagnostic-bundle",
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

        transcript_root = temp_root / "memory-agent-transcripts"
        preview = await preview_memory_observation_from_paths(
            list(materialized.transcript_paths),
            deployment=deployment,
            extraction_id_value=extraction_id,
            job_id=extraction_id,
            source_workflow=request.source_workflow,
            run_id=request.run_id,
            agent_transcript_root=transcript_root,
        )
        if preview.agent_transcript_path is None:
            raise RuntimeError("Memory extraction did not record its transcript.")
        extraction_transcript_reference = publish_memory_agent_transcript(
            agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
            transcript_path=preview.agent_transcript_path,
            output_dir=temp_root / "published-transcripts",
        )
        catalog_client.register_extraction(
            extraction_id=extraction_id,
            source_workflow=request.source_workflow,
            source_run_id=request.run_id,
            source_review_unit_id=request.review_unit_id,
            diagnostic_bundle_digest=reference.digest,
            transcript_reference=extraction_transcript_reference,
            observation_markdown=preview.observation_markdown,
        )
        return {
            "ok": True,
            "skipped": preview.skipped,
            "summary": preview.summary,
            "extraction_id": extraction_id,
            "observation_produced": preview.observation_markdown is not None,
            "transcript_reference": extraction_transcript_reference.as_dict(),
        }


@activity.defn
async def run_memory_extraction_activity(
    request: MemoryExtractionRequest,
) -> dict[str, Any]:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import MemoryCatalogConflictError
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    if not memory_processing_enabled():
        return {
            "ok": True,
            "skipped": True,
            "reason": "AGENT_MEMORY_PROCESSING_ENABLED is false.",
        }
    try:
        return await run_memory_extraction(request)
    except MemoryCatalogConflictError as error:
        raise ApplicationError(
            str(error),
            type="MEMORY_CATALOG_EXTRACTION_CONFLICT",
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
    "memory_extraction_workflow_id",
    "run_memory_extraction",
    "run_memory_extraction_activity",
]
