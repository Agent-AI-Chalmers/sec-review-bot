import hashlib
import tempfile
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal

from temporalio import activity, workflow

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.temporal.support import activity_retry_policy


@dataclass(frozen=True)
class MemoryExtractionRequest:
    """Extract durable memory from one unit in an immutable run diagnostic."""

    source_workflow: str
    run_id: str
    unit_id: str
    diagnostic_bundle: dict[str, Any]
    timeout_seconds: int


@dataclass(frozen=True)
class MemoryExtractionRegistrationPayload:
    extraction_id: str
    source_workflow: str
    source_run_id: str
    source_unit_id: str
    diagnostic_bundle_digest: str
    transcript_reference: ArtifactReference
    observation_markdown: str | None
    skipped: bool
    summary: str
    observation_produced: bool

    def __post_init__(self) -> None:
        string_fields = (
            self.extraction_id,
            self.source_workflow,
            self.source_run_id,
            self.source_unit_id,
            self.diagnostic_bundle_digest,
            self.summary,
        )
        if any(not isinstance(value, str) for value in string_fields):
            raise TypeError("Memory extraction provenance and summary must be strings.")
        if not isinstance(self.transcript_reference, ArtifactReference):
            raise TypeError("Memory extraction transcript_reference is invalid.")
        if self.observation_markdown is not None and not isinstance(
            self.observation_markdown, str
        ):
            raise TypeError("Memory extraction observation_markdown must be a string.")
        if not isinstance(self.skipped, bool):
            raise TypeError("Memory extraction skipped must be a boolean.")
        if not isinstance(self.observation_produced, bool):
            raise TypeError("Memory extraction observation_produced must be a boolean.")
        observation_exists = self.observation_markdown is not None
        if self.observation_produced is not observation_exists:
            raise ValueError(
                "Memory extraction observation_produced must match observation_markdown."
            )
        if self.skipped is observation_exists:
            raise ValueError(
                "Memory extraction skipped must be false exactly when an observation exists."
            )


@dataclass(frozen=True)
class MemoryExtractionPreparationResult:
    kind: Literal["disabled", "prepared"]
    registration_payload: MemoryExtractionRegistrationPayload | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if self.kind == "disabled":
            if (
                self.registration_payload is not None
                or not isinstance(self.reason, str)
                or not self.reason.strip()
            ):
                raise ValueError(
                    "Disabled extraction preparation requires only a reason."
                )
            return
        if self.kind == "prepared":
            if (
                not isinstance(
                    self.registration_payload, MemoryExtractionRegistrationPayload
                )
                or self.reason is not None
            ):
                raise ValueError(
                    "Prepared extraction requires only a registration payload."
                )
            return
        raise ValueError(
            f"Unsupported memory extraction preparation kind: {self.kind!r}"
        )


def memory_extraction_workflow_id(
    *,
    diagnostic_bundle_digest: str,
    unit_id: str,
) -> str:
    """Return the stable Temporal identity for one transcript unit."""
    identity = f"{diagnostic_bundle_digest}\0{unit_id}".encode()
    return f"memory-extraction:{hashlib.sha256(identity).hexdigest()}"


async def prepare_memory_extraction(
    request: MemoryExtractionRequest,
    *,
    deployment: str | None = None,
) -> MemoryExtractionRegistrationPayload:
    from sec_review_agents.agents.memory_extractor.agent import (
        MEMORY_EXTRACTOR_AGENT_NAME,
    )
    from sec_review_agents.memory.extractor import (
        preview_memory_observation_from_paths,
    )
    from sec_review_agents.memory.transcript_artifact import (
        publish_memory_agent_transcript,
    )
    from sec_review_agents.run_diagnostics.bundle import (
        materialize_diagnostic_transcript_unit,
    )
    from sec_review_agents.runtime.transcripts import transcript_path

    reference = ArtifactReference.from_mapping(request.diagnostic_bundle)
    extraction_id = memory_extraction_workflow_id(
        diagnostic_bundle_digest=reference.digest,
        unit_id=request.unit_id,
    )
    with tempfile.TemporaryDirectory(prefix="sec-review-extraction-input-") as tempdir:
        temp_root = Path(tempdir)
        materialized = materialize_diagnostic_transcript_unit(
            reference,
            run_id=request.run_id,
            unit_id=request.unit_id,
            destination=temp_root / "diagnostic-bundle",
        )
        extractor_transcript_path = transcript_path(
            temp_root / "memory-agent-transcripts",
            name="extractor",
        )
        preview = await preview_memory_observation_from_paths(
            list(materialized.transcript_paths),
            deployment=deployment,
            extraction_id_value=extraction_id,
            job_id=extraction_id,
            source_workflow=request.source_workflow,
            run_id=request.run_id,
            extractor_transcript_path=extractor_transcript_path,
        )
        if preview.extractor_transcript_path is None:
            raise RuntimeError("Memory extraction did not record its transcript.")
        extraction_transcript_reference = publish_memory_agent_transcript(
            agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
            transcript_path=preview.extractor_transcript_path,
            output_dir=temp_root / "published-transcripts",
        )
        return MemoryExtractionRegistrationPayload(
            extraction_id=extraction_id,
            source_workflow=request.source_workflow,
            source_run_id=request.run_id,
            source_unit_id=request.unit_id,
            diagnostic_bundle_digest=reference.digest,
            transcript_reference=extraction_transcript_reference,
            observation_markdown=preview.observation_markdown,
            skipped=preview.skipped,
            summary=preview.summary,
            observation_produced=preview.observation_markdown is not None,
        )


@activity.defn
async def prepare_memory_extraction_activity(
    request: MemoryExtractionRequest,
) -> MemoryExtractionPreparationResult:
    from sec_review_agents.features import memory_processing_enabled
    from sec_review_agents.memory.catalog_client import (
        configured_memory_catalog_client,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    if not memory_processing_enabled():
        return MemoryExtractionPreparationResult(
            kind="disabled",
            reason="AGENT_MEMORY_PROCESSING_ENABLED is false.",
        )
    if configured_memory_catalog_client() is None:
        raise ValueError(
            "AGENT_MEMORY_CATALOG_URL is required when memory processing is enabled."
        )
    return MemoryExtractionPreparationResult(
        kind="prepared",
        registration_payload=await prepare_memory_extraction(request),
    )


@activity.defn
def register_memory_extraction_activity(
    payload: MemoryExtractionRegistrationPayload,
) -> dict[str, Any]:
    from temporalio.exceptions import ApplicationError

    from sec_review_agents.memory.catalog_client import (
        MemoryCatalogConflictError,
        configured_memory_catalog_client,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    catalog_client = configured_memory_catalog_client()
    if catalog_client is None:
        raise RuntimeError("Memory catalog is required to register an extraction.")
    try:
        catalog_client.register_extraction(
            extraction_id=payload.extraction_id,
            source_workflow=payload.source_workflow,
            source_run_id=payload.source_run_id,
            source_unit_id=payload.source_unit_id,
            diagnostic_bundle_digest=payload.diagnostic_bundle_digest,
            transcript_reference=payload.transcript_reference,
            observation_markdown=payload.observation_markdown,
        )
    except MemoryCatalogConflictError as error:
        raise ApplicationError(
            str(error),
            type="MEMORY_CATALOG_EXTRACTION_CONFLICT",
            non_retryable=True,
        ) from error
    return {
        "ok": True,
        "skipped": payload.skipped,
        "summary": payload.summary,
        "extraction_id": payload.extraction_id,
        "observation_produced": payload.observation_produced,
        "transcript_reference": payload.transcript_reference.as_dict(),
    }


@workflow.defn
class MemoryExtractionWorkflow:
    @workflow.run
    async def run(self, request: MemoryExtractionRequest) -> dict[str, Any]:
        prepared = await workflow.execute_activity(
            prepare_memory_extraction_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        if prepared.kind == "disabled":
            assert prepared.reason is not None
            return {"ok": True, "skipped": True, "reason": prepared.reason}
        assert prepared.registration_payload is not None
        return await workflow.execute_activity(
            register_memory_extraction_activity,
            prepared.registration_payload,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )


__all__ = [
    "MemoryExtractionPreparationResult",
    "MemoryExtractionRegistrationPayload",
    "MemoryExtractionRequest",
    "MemoryExtractionWorkflow",
    "memory_extraction_workflow_id",
    "prepare_memory_extraction",
    "prepare_memory_extraction_activity",
    "register_memory_extraction_activity",
]
