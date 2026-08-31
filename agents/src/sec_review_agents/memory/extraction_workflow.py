import asyncio
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from temporalio import activity, workflow

from sec_review_agents.temporal.support import activity_retry_policy

MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE = 10
MEMORY_EXTRACTION_RUNNING_STALE_AFTER_SECONDS = 60 * 60


@dataclass(frozen=True)
class MemoryExtractionRequest:
    source_workflow: str
    run_id: str
    artifact_root_path: str
    timeout_seconds: int


@dataclass(frozen=True)
class MemoryExtractionRunRequest:
    timeout_seconds: int
    batch_size: int = MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE


@dataclass(frozen=True)
class MemoryExtractionJobRequest:
    job_id: str
    source_workflow: str
    run_id: str
    artifact_root_path: str


def memory_extraction_request_for_review(
    request: Any,
) -> MemoryExtractionRequest | None:
    prepared_input = getattr(request, "prepared_input", None)
    if not isinstance(prepared_input, dict):
        return None
    artifact_root_path = prepared_input.get("artifact_root_path")
    if not isinstance(artifact_root_path, str) or not artifact_root_path.strip():
        return None
    return MemoryExtractionRequest(
        source_workflow=str(request.workflow),
        run_id=str(request.run_id),
        artifact_root_path=artifact_root_path.strip(),
        timeout_seconds=int(request.timeout_seconds),
    )


def memory_extraction_job_id(request: MemoryExtractionRequest) -> str:
    return f"{request.source_workflow}-{request.run_id}"


async def register_memory_extraction_for_review(request: Any) -> None:
    if getattr(request, "memory_extraction_registration_enabled", True) is False:
        return
    extraction_request = memory_extraction_request_for_review(request)
    if extraction_request is None:
        return
    try:
        await workflow.execute_activity(
            register_memory_extraction_job_activity,
            extraction_request,
            schedule_to_close_timeout=timedelta(
                seconds=extraction_request.timeout_seconds
            ),
            retry_policy=activity_retry_policy(),
        )
    except Exception as error:
        workflow.logger.warning(
            "Failed to register memory extraction job for %s: %s",
            request.run_id,
            error,
        )


@activity.defn
def register_memory_extraction_job_activity(
    request: MemoryExtractionRequest,
) -> dict[str, Any]:
    from sec_review_agents.features import agent_memory_enabled
    from sec_review_agents.memory.store import resolve_memory_store_dir
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return {
            "ok": True,
            "skipped": True,
            "reason": (
                "AGENT_MEMORY_ENABLED is false."
                if not agent_memory_enabled()
                else "AGENT_MEMORY_DIR is not configured."
            ),
        }

    from sec_review_agents.memory.state import (
        EXTRACTION_JOB_STATUS_FAILED,
        EXTRACTION_JOB_STATUS_PROCESSED,
        fetch_extraction_job_by_id,
        open_memory_state,
        register_pending_extraction_job,
    )
    from sec_review_agents.memory.store import initialize_memory_store

    initialize_memory_store(memory_store_dir)
    job_id = memory_extraction_job_id(request)
    with open_memory_state(memory_store_dir) as connection:
        existing = fetch_extraction_job_by_id(connection, job_id)
        if existing is not None and existing.status == EXTRACTION_JOB_STATUS_PROCESSED:
            return {
                "ok": True,
                "skipped": True,
                "reason": "Memory extraction job already processed.",
                "job_id": job_id,
            }
        if existing is not None and existing.status == EXTRACTION_JOB_STATUS_FAILED:
            return {
                "ok": True,
                "skipped": True,
                "reason": "Memory extraction job already failed.",
                "job_id": job_id,
            }
        registered = register_pending_extraction_job(
            connection,
            job_id=job_id,
            source_workflow=request.source_workflow,
            run_id=request.run_id,
            artifact_root_path=request.artifact_root_path,
        )
    return {
        "ok": True,
        "skipped": not registered,
        "job_id": job_id,
    }


async def run_memory_extraction_job(
    *,
    memory_store_dir: Path,
    job_id: str,
    source_workflow: str,
    run_id: str,
    artifact_root_path: str,
    deployment: str | None = None,
) -> dict[str, Any]:
    from sec_review_agents.memory.extractor import (
        extract_memory_observations_from_paths,
    )
    from sec_review_agents.memory.state import (
        is_extraction_job_running,
        mark_running_extraction_job_processed,
        open_memory_state,
    )
    from sec_review_agents.memory.store import initialize_memory_store

    initialize_memory_store(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        if not is_extraction_job_running(connection, job_id=job_id):
            raise RuntimeError(f"Extraction job is not running: {job_id}")
    result = await extract_memory_observations_from_paths(
        [Path(artifact_root_path)],
        memory_store_dir=memory_store_dir,
        deployment=deployment,
        source_workflow=source_workflow,
        run_id=run_id,
        artifact_root_path=Path(artifact_root_path),
    )
    with open_memory_state(memory_store_dir) as connection:
        marked = mark_running_extraction_job_processed(
            connection,
            job_id=job_id,
        )
    if not marked:
        raise RuntimeError(f"Extraction job is not running: {job_id}")
    return {
        "ok": True,
        "skipped": result.skipped,
        "summary": result.summary,
        "observation_paths": [str(path) for path in result.observation_paths],
        "job_id": job_id,
        "source_workflow": source_workflow,
        "run_id": run_id,
    }


@activity.defn
def claim_pending_memory_extraction_jobs_activity(
    request: MemoryExtractionRunRequest,
) -> dict[str, Any]:
    from sec_review_agents.features import agent_memory_enabled
    from sec_review_agents.memory.state import (
        claim_pending_extraction_jobs,
        fail_stale_running_extraction_jobs,
        open_memory_state,
    )
    from sec_review_agents.memory.store import (
        initialize_memory_store,
        resolve_memory_store_dir,
    )
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    if request.batch_size < 1:
        raise ValueError("Memory extraction batch_size must be positive.")
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return {
            "ok": True,
            "skipped": True,
            "reason": (
                "AGENT_MEMORY_ENABLED is false."
                if not agent_memory_enabled()
                else "AGENT_MEMORY_DIR is not configured."
            ),
            "processed_count": 0,
            "jobs": [],
        }

    initialize_memory_store(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        # Jobs that sit in running too long are treated as terminal failures.
        fail_stale_running_extraction_jobs(
            connection,
            stale_after_seconds=max(
                request.timeout_seconds,
                MEMORY_EXTRACTION_RUNNING_STALE_AFTER_SECONDS,
            ),
        )
        jobs = claim_pending_extraction_jobs(
            connection,
            limit=request.batch_size,
        )
    return {
        "ok": True,
        "skipped": False,
        "jobs": [
            {
                "job_id": job.job_id,
                "source_workflow": job.source_workflow,
                "run_id": job.run_id,
                "artifact_root_path": job.artifact_root_path,
            }
            for job in jobs
        ],
    }


@activity.defn
async def run_memory_extraction_job_activity(
    request: MemoryExtractionJobRequest,
) -> dict[str, Any]:
    from sec_review_agents.features import agent_memory_enabled
    from sec_review_agents.memory.store import resolve_memory_store_dir
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        raise RuntimeError(
            "AGENT_MEMORY_ENABLED is false."
            if not agent_memory_enabled()
            else "AGENT_MEMORY_DIR is not configured."
        )
    return await run_memory_extraction_job(
        memory_store_dir=memory_store_dir,
        job_id=request.job_id,
        source_workflow=request.source_workflow,
        run_id=request.run_id,
        artifact_root_path=request.artifact_root_path,
        deployment=None,
    )


@activity.defn
def mark_memory_extraction_job_failed_activity(
    request: MemoryExtractionJobRequest,
) -> dict[str, Any]:
    from sec_review_agents.features import agent_memory_enabled
    from sec_review_agents.memory.state import (
        mark_running_extraction_job_failed,
        open_memory_state,
    )
    from sec_review_agents.memory.store import resolve_memory_store_dir
    from sec_review_agents.utils.env import bootstrap_agents_env

    bootstrap_agents_env()
    memory_store_dir = resolve_memory_store_dir(None, required=False)
    if memory_store_dir is None:
        return {
            "ok": False,
            "job_id": request.job_id,
            "error": (
                "AGENT_MEMORY_ENABLED is false."
                if not agent_memory_enabled()
                else "AGENT_MEMORY_DIR is not configured."
            ),
        }
    with open_memory_state(memory_store_dir) as connection:
        marked = mark_running_extraction_job_failed(
            connection,
            job_id=request.job_id,
        )
    return {
        "ok": marked,
        "job_id": request.job_id,
        "marked": marked,
    }


def _job_request_from_claimed_job(job: dict[str, Any]) -> MemoryExtractionJobRequest:
    return MemoryExtractionJobRequest(
        job_id=str(job["job_id"]),
        source_workflow=str(job["source_workflow"]),
        run_id=str(job["run_id"]),
        artifact_root_path=str(job["artifact_root_path"]),
    )


def _summarize_extraction_job_results(
    results: list[Any],
) -> dict[str, Any]:
    successful_results: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    for result in results:
        if isinstance(result, Exception):
            failures.append(
                {
                    "job_id": str(getattr(result, "job_id", "<activity-error>")),
                    "error": str(result),
                }
            )
            continue
        if not bool(result.get("ok")):
            failures.append(
                {
                    "job_id": str(result.get("job_id") or "<unknown-job>"),
                    "error": str(
                        result.get("error") or "Memory extraction job failed."
                    ),
                }
            )
            continue
        successful_results.append(result)
    return {
        "ok": not failures,
        "skipped": False,
        "processed_count": len(successful_results),
        "failure_count": len(failures),
        "job_ids": [result["job_id"] for result in successful_results],
        "failures": failures,
    }


async def _run_memory_extraction_job_with_failure_finalizer(
    job: MemoryExtractionJobRequest,
    *,
    timeout_seconds: int,
) -> dict[str, Any]:
    try:
        return await workflow.execute_activity(
            run_memory_extraction_job_activity,
            job,
            schedule_to_close_timeout=timedelta(seconds=timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
    except Exception as error:
        try:
            # Keep the original extraction failure visible even if the terminal state
            # update itself runs into a transient worker or database problem.
            await workflow.execute_activity(
                mark_memory_extraction_job_failed_activity,
                job,
                schedule_to_close_timeout=timedelta(seconds=timeout_seconds),
                retry_policy=activity_retry_policy(),
            )
        except Exception as finalizer_error:
            _ = finalizer_error
        # Temporal wraps activity failures, so attach the job id dynamically for
        # callers that surface the original extraction failure.
        setattr(error, "job_id", job.job_id)  # noqa: B010
        raise


@workflow.defn
class MemoryExtractionWorkflow:
    @workflow.run
    async def run(self, request: MemoryExtractionRunRequest) -> dict[str, Any]:
        claim_result = await workflow.execute_activity(
            claim_pending_memory_extraction_jobs_activity,
            request,
            schedule_to_close_timeout=timedelta(seconds=request.timeout_seconds),
            retry_policy=activity_retry_policy(),
        )
        if claim_result.get("skipped"):
            return {
                "ok": True,
                "skipped": True,
                "reason": claim_result.get("reason"),
                "processed_count": 0,
            }
        jobs = [
            _job_request_from_claimed_job(job)
            for job in claim_result.get("jobs", [])
            if isinstance(job, dict)
        ]
        results = await asyncio.gather(
            *[
                _run_memory_extraction_job_with_failure_finalizer(
                    job,
                    timeout_seconds=request.timeout_seconds,
                )
                for job in jobs
            ],
            return_exceptions=True,
        )
        return _summarize_extraction_job_results(list(results))


__all__ = [
    "MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE",
    "MEMORY_EXTRACTION_RUNNING_STALE_AFTER_SECONDS",
    "MemoryExtractionJobRequest",
    "MemoryExtractionRequest",
    "MemoryExtractionRunRequest",
    "MemoryExtractionWorkflow",
    "claim_pending_memory_extraction_jobs_activity",
    "mark_memory_extraction_job_failed_activity",
    "memory_extraction_job_id",
    "memory_extraction_request_for_review",
    "register_memory_extraction_for_review",
    "register_memory_extraction_job_activity",
    "run_memory_extraction_job",
    "run_memory_extraction_job_activity",
]
