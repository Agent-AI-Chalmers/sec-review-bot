from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.memory import store as memory_store
from sec_review_agents.memory.extraction_workflow import (
    MemoryExtractionJobRequest,
    MemoryExtractionRequest,
    MemoryExtractionRunRequest,
    MemoryExtractionWorkflow,
    claim_pending_memory_extraction_jobs_activity,
    mark_memory_extraction_job_failed_activity,
    memory_extraction_job_id,
    memory_extraction_request_for_review,
    register_memory_extraction_job_activity,
    run_memory_extraction_job_activity,
)
from sec_review_agents.memory.maintenance_workflow import (
    MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE,
    MEMORY_MAINTENANCE_PENDING_MAX_AGE,
    MEMORY_MAINTENANCE_PENDING_THRESHOLD,
    MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceTriggerRequest,
    MemoryMaintenanceTriggerWorkflow,
    MemoryMaintenanceWorkflow,
    count_pending_memory_observations_activity,
    maybe_start_memory_maintenance_for_pending_observations,
    run_memory_maintenance_activity,
)
from sec_review_agents.memory.state import (
    EXTRACTION_JOB_STATUS_FAILED,
    EXTRACTION_JOB_STATUS_PENDING,
    EXTRACTION_JOB_STATUS_PROCESSED,
    EXTRACTION_JOB_STATUS_RUNNING,
    OBSERVATION_STATUS_PENDING,
    OBSERVATION_STATUS_PROCESSED,
    claim_pending_extraction_jobs,
    count_observations_by_status,
    fetch_all_extraction_jobs,
    initialize_memory_state,
    oldest_observation_created_at_by_status,
    open_memory_state,
    upsert_extraction_job,
    upsert_observation,
)


def _fake_workflow_logger() -> SimpleNamespace:
    return SimpleNamespace(
        info=lambda *_args, **_kwargs: None,
        warning=lambda *_args, **_kwargs: None,
    )


def test_worker_imports_memory_maintenance_workflow_and_activity() -> None:
    from sec_review_agents.runner.service import worker

    assert worker.MemoryMaintenanceTriggerWorkflow is MemoryMaintenanceTriggerWorkflow
    assert worker.MemoryMaintenanceWorkflow is MemoryMaintenanceWorkflow
    assert worker.run_memory_maintenance_activity is run_memory_maintenance_activity
    assert (
        worker.count_pending_memory_observations_activity
        is count_pending_memory_observations_activity
    )
    assert (
        worker.register_memory_extraction_job_activity
        is register_memory_extraction_job_activity
    )
    assert (
        worker.claim_pending_memory_extraction_jobs_activity
        is claim_pending_memory_extraction_jobs_activity
    )
    assert (
        worker.mark_memory_extraction_job_failed_activity
        is mark_memory_extraction_job_failed_activity
    )
    assert (
        worker.run_memory_extraction_job_activity is run_memory_extraction_job_activity
    )


def test_memory_extraction_job_id_is_per_review() -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path="/tmp/run/artifacts",
        timeout_seconds=30,
    )

    assert memory_extraction_job_id(request) == "issue-review-run-1"


def test_register_memory_extraction_job_activity_writes_pending_job(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path="/tmp/run/artifacts",
        timeout_seconds=30,
    )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = register_memory_extraction_job_activity(request)

    assert result == {
        "ok": True,
        "skipped": False,
        "job_id": "issue-review-run-1",
    }
    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    assert len(jobs) == 1
    assert jobs[0].job_id == "issue-review-run-1"
    assert jobs[0].status == EXTRACTION_JOB_STATUS_PENDING


def test_register_memory_extraction_job_activity_skips_processed_job(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="issue-review-run-1",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/artifacts",
            status=EXTRACTION_JOB_STATUS_PROCESSED,
        )
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path="/tmp/run/artifacts",
        timeout_seconds=30,
    )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = register_memory_extraction_job_activity(request)

    assert result == {
        "ok": True,
        "skipped": True,
        "reason": "Memory extraction job already processed.",
        "job_id": "issue-review-run-1",
    }


def test_register_memory_extraction_job_activity_does_not_demote_running_job(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="issue-review-run-1",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/artifacts",
            status=EXTRACTION_JOB_STATUS_RUNNING,
        )
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path="/tmp/run/artifacts",
        timeout_seconds=30,
    )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = register_memory_extraction_job_activity(request)

    assert result == {
        "ok": True,
        "skipped": True,
        "job_id": "issue-review-run-1",
    }
    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    assert jobs[0].status == EXTRACTION_JOB_STATUS_RUNNING


def test_memory_extraction_request_for_review_uses_artifact_root() -> None:
    request = SimpleNamespace(
        workflow="issue-review",
        run_id="run-1",
        timeout_seconds=30,
        prepared_input={"artifact_root_path": "/tmp/run/artifacts"},
    )

    extraction_request = memory_extraction_request_for_review(request)

    assert extraction_request == MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path="/tmp/run/artifacts",
        timeout_seconds=30,
    )


def test_memory_extraction_request_for_review_requires_artifact_root() -> None:
    request = SimpleNamespace(
        workflow="issue-review",
        run_id="run-1",
        timeout_seconds=30,
        prepared_input={},
    )

    assert memory_extraction_request_for_review(request) is None


@pytest.mark.asyncio
async def test_run_memory_extraction_job_requires_claimed_running_job(
    tmp_path,
) -> None:
    from sec_review_agents.memory.extraction_workflow import run_memory_extraction_job

    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="issue-review-run-1",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/artifacts",
            status=EXTRACTION_JOB_STATUS_PENDING,
        )

    with (
        patch(
            "sec_review_agents.memory.extractor.extract_memory_observations_from_paths",
            return_value=SimpleNamespace(
                skipped=False,
                summary="Memory observation written.",
                observation_paths=(),
            ),
        ) as extract,
        pytest.raises(RuntimeError, match="not running"),
    ):
        await run_memory_extraction_job(
            memory_store_dir=memory_store_dir,
            job_id="issue-review-run-1",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/artifacts",
            deployment=None,
        )

    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    extract.assert_not_called()
    assert jobs[0].status == EXTRACTION_JOB_STATUS_PENDING


def test_register_memory_extraction_job_activity_skips_failed_job(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="issue-review-run-1",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/artifacts",
            status=EXTRACTION_JOB_STATUS_FAILED,
        )

    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path="/tmp/run/artifacts-new",
        timeout_seconds=30,
    )
    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = register_memory_extraction_job_activity(request)

    assert result == {
        "ok": True,
        "skipped": True,
        "reason": "Memory extraction job already failed.",
        "job_id": "issue-review-run-1",
    }
    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    assert jobs[0].status == EXTRACTION_JOB_STATUS_FAILED
    assert jobs[0].artifact_root_path == "/tmp/run/artifacts"


def test_claim_pending_extraction_jobs_marks_rows_running(tmp_path: Path) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="first",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/one",
            status=EXTRACTION_JOB_STATUS_PENDING,
        )
        upsert_extraction_job(
            connection,
            job_id="second",
            source_workflow="issue-review",
            run_id="run-2",
            artifact_root_path="/tmp/run/two",
            status=EXTRACTION_JOB_STATUS_PENDING,
        )
        claimed = claim_pending_extraction_jobs(connection, limit=1)
        second_claim = claim_pending_extraction_jobs(connection, limit=10)

    assert [job.job_id for job in claimed] == ["first"]
    assert claimed[0].status == EXTRACTION_JOB_STATUS_RUNNING
    assert [job.job_id for job in second_claim] == ["second"]


def test_claim_pending_memory_extraction_jobs_fails_stale_running_jobs(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    stale_created_at = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="stale",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/stale",
            status=EXTRACTION_JOB_STATUS_RUNNING,
        )
        connection.execute(
            """
            update extraction_jobs
            set updated_at = ?
            where job_id = ?
            """,
            (stale_created_at, "stale"),
        )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = claim_pending_memory_extraction_jobs_activity(
            MemoryExtractionRunRequest(
                timeout_seconds=30,
                batch_size=1,
            )
        )

    assert result["jobs"] == []
    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    assert jobs[0].status == EXTRACTION_JOB_STATUS_FAILED


@pytest.mark.asyncio
async def test_run_memory_extraction_job_leaves_running_job_for_workflow_finalizer(
    tmp_path: Path,
) -> None:
    from sec_review_agents.memory.extraction_workflow import run_memory_extraction_job

    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="first",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/one",
            status=EXTRACTION_JOB_STATUS_RUNNING,
        )

    with (
        patch(
            "sec_review_agents.memory.extractor.extract_memory_observations_from_paths",
            side_effect=RuntimeError("llm failed"),
        ),
        pytest.raises(RuntimeError, match="llm failed"),
    ):
        await run_memory_extraction_job(
            memory_store_dir=memory_store_dir,
            job_id="first",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/one",
            deployment=None,
        )

    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    assert jobs[0].status == EXTRACTION_JOB_STATUS_RUNNING


@pytest.mark.asyncio
async def test_run_memory_extraction_job_activity_raises_for_temporal_retry(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="first",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/one",
            status=EXTRACTION_JOB_STATUS_RUNNING,
        )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
        patch(
            "sec_review_agents.memory.extractor.extract_memory_observations_from_paths",
            side_effect=RuntimeError("llm failed"),
        ),
        pytest.raises(RuntimeError, match="llm failed"),
    ):
        await run_memory_extraction_job_activity(
            MemoryExtractionJobRequest(
                job_id="first",
                source_workflow="issue-review",
                run_id="run-1",
                artifact_root_path="/tmp/run/one",
            )
        )

    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    assert jobs[0].status == EXTRACTION_JOB_STATUS_RUNNING


def test_mark_memory_extraction_job_failed_activity_marks_running_job(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store_dir.mkdir(parents=True)
    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="first",
            source_workflow="issue-review",
            run_id="run-1",
            artifact_root_path="/tmp/run/one",
            status=EXTRACTION_JOB_STATUS_RUNNING,
        )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = mark_memory_extraction_job_failed_activity(
            MemoryExtractionJobRequest(
                job_id="first",
                source_workflow="issue-review",
                run_id="run-1",
                artifact_root_path="/tmp/run/one",
            )
        )

    assert result == {"ok": True, "job_id": "first", "marked": True}
    with open_memory_state(memory_store_dir) as connection:
        jobs = fetch_all_extraction_jobs(connection)
    assert jobs[0].status == EXTRACTION_JOB_STATUS_FAILED


@pytest.mark.asyncio
async def test_memory_extraction_workflow_fans_out_claimed_jobs(monkeypatch) -> None:
    activity_calls = []
    request = MemoryExtractionRunRequest(timeout_seconds=30, batch_size=2)

    async def fake_execute_activity(activity_fn, activity_request, **kwargs):
        activity_calls.append((activity_fn, activity_request, kwargs))
        if activity_fn is claim_pending_memory_extraction_jobs_activity:
            return {
                "ok": True,
                "skipped": False,
                "jobs": [
                    {
                        "job_id": "first",
                        "source_workflow": "issue-review",
                        "run_id": "run-1",
                        "artifact_root_path": "/tmp/run/one",
                    },
                    {
                        "job_id": "second",
                        "source_workflow": "issue-review",
                        "run_id": "run-2",
                        "artifact_root_path": "/tmp/run/two",
                    },
                ],
            }
        if activity_fn is run_memory_extraction_job_activity:
            assert isinstance(activity_request, MemoryExtractionJobRequest)
            if activity_request.job_id == "second":
                raise RuntimeError("second failed")
            return {
                "ok": True,
                "job_id": activity_request.job_id,
                "skipped": False,
                "summary": "done",
                "observation_paths": [],
                "source_workflow": activity_request.source_workflow,
                "run_id": activity_request.run_id,
            }
        if activity_fn is mark_memory_extraction_job_failed_activity:
            assert isinstance(activity_request, MemoryExtractionJobRequest)
            if activity_request.job_id == "second":
                raise RuntimeError("finalizer failed")
            return {
                "ok": True,
                "job_id": activity_request.job_id,
                "marked": True,
            }
        raise AssertionError(f"Unexpected activity: {activity_fn}")

    monkeypatch.setattr(
        "sec_review_agents.memory.extraction_workflow.workflow.execute_activity",
        fake_execute_activity,
    )

    result = await MemoryExtractionWorkflow().run(request)

    assert result == {
        "ok": False,
        "skipped": False,
        "processed_count": 1,
        "failure_count": 1,
        "job_ids": ["first"],
        "failures": [{"job_id": "second", "error": "second failed"}],
    }
    assert [call[0] for call in activity_calls] == [
        claim_pending_memory_extraction_jobs_activity,
        run_memory_extraction_job_activity,
        run_memory_extraction_job_activity,
        mark_memory_extraction_job_failed_activity,
    ]
    assert activity_calls[0][2]["retry_policy"].maximum_attempts == 3
    assert activity_calls[1][2]["retry_policy"].maximum_attempts == 3
    assert activity_calls[2][2]["retry_policy"].maximum_attempts == 3
    assert activity_calls[3][2]["retry_policy"].maximum_attempts == 3


@pytest.mark.asyncio
async def test_memory_extraction_workflow_keeps_original_failure_when_finalizer_fails(
    monkeypatch,
) -> None:
    request = MemoryExtractionRunRequest(timeout_seconds=30, batch_size=1)

    async def fake_execute_activity(activity_fn, activity_request, **kwargs):
        if activity_fn is claim_pending_memory_extraction_jobs_activity:
            return {
                "ok": True,
                "skipped": False,
                "jobs": [
                    {
                        "job_id": "first",
                        "source_workflow": "issue-review",
                        "run_id": "run-1",
                        "artifact_root_path": "/tmp/run/one",
                    }
                ],
            }
        if activity_fn is run_memory_extraction_job_activity:
            raise RuntimeError("extract failed")
        if activity_fn is mark_memory_extraction_job_failed_activity:
            raise RuntimeError("finalizer failed")
        raise AssertionError(f"Unexpected activity: {activity_fn}")

    monkeypatch.setattr(
        "sec_review_agents.memory.extraction_workflow.workflow.execute_activity",
        fake_execute_activity,
    )

    result = await MemoryExtractionWorkflow().run(request)

    assert result == {
        "ok": False,
        "skipped": False,
        "processed_count": 0,
        "failure_count": 1,
        "job_ids": [],
        "failures": [{"job_id": "first", "error": "extract failed"}],
    }


@pytest.mark.asyncio
async def test_run_memory_maintenance_activity_skips_without_memory_dir() -> None:
    request = MemoryMaintenanceRequest(timeout_seconds=30)

    with (
        patch.dict("os.environ", {}, clear=True),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = await run_memory_maintenance_activity(request)

    assert result == {
        "ok": True,
        "skipped": True,
        "reason": "AGENT_MEMORY_DIR is not configured.",
    }


@pytest.mark.asyncio
async def test_run_memory_maintenance_activity_skips_when_memory_globally_disabled() -> (
    None
):
    request = MemoryMaintenanceRequest(timeout_seconds=30)

    with (
        patch.dict("os.environ", {"AGENT_MEMORY_ENABLED": "false"}, clear=True),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = await run_memory_maintenance_activity(request)

    assert result == {
        "ok": True,
        "skipped": True,
        "reason": "AGENT_MEMORY_ENABLED is false.",
    }


def test_register_memory_extraction_job_activity_skips_when_memory_globally_disabled(
    tmp_path: Path,
) -> None:
    request = MemoryExtractionRequest(
        source_workflow="issue-review",
        run_id="run-1",
        artifact_root_path=str(tmp_path / "artifacts"),
        timeout_seconds=30,
    )

    with (
        patch.dict("os.environ", {"AGENT_MEMORY_ENABLED": "false"}, clear=True),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = register_memory_extraction_job_activity(request)

    assert result == {
        "ok": True,
        "skipped": True,
        "reason": "AGENT_MEMORY_ENABLED is false.",
    }


def test_count_pending_memory_observations_activity_skips_when_memory_globally_disabled() -> (
    None
):
    with (
        patch.dict("os.environ", {"AGENT_MEMORY_ENABLED": "false"}, clear=True),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = count_pending_memory_observations_activity()

    assert result == {
        "ok": True,
        "skipped": True,
        "pending_count": 0,
        "reason": "AGENT_MEMORY_ENABLED is false.",
    }


@pytest.mark.asyncio
async def test_run_memory_maintenance_activity_returns_processed_count(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    request = MemoryMaintenanceRequest(
        timeout_seconds=30,
        batch_size=MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE,
    )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
        patch(
            "sec_review_agents.memory.maintainer.maintain_memory_with_result",
            return_value=SimpleNamespace(
                summary="Memory maintained.",
                processed_count=2,
                skipped=False,
            ),
        ) as maintain,
    ):
        result = await run_memory_maintenance_activity(request)

    maintain.assert_called_once_with(
        memory_store_dir=memory_store_dir.resolve(),
        deployment=None,
        batch_size=MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE,
    )
    assert result["ok"] is True
    assert result["skipped"] is False
    assert result["processed_count"] == 2


def test_count_pending_memory_observations_activity_counts_pending_only(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    observations_root = memory_store.memory_observations_dir(memory_store_dir)
    observations_root.mkdir(parents=True)
    pending = observations_root / "pending.md"
    processed = observations_root / "processed.md"
    pending.write_text("pending\n", encoding="utf-8")
    processed.write_text("processed\n", encoding="utf-8")

    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_observation(
            connection,
            observation_id="pending",
            path=str(pending),
            status=OBSERVATION_STATUS_PENDING,
        )
        upsert_observation(
            connection,
            observation_id="processed",
            path=str(processed),
            status=OBSERVATION_STATUS_PROCESSED,
        )

    with (
        patch.dict(
            "os.environ", {"AGENT_MEMORY_DIR": str(memory_store_dir)}, clear=True
        ),
        patch("sec_review_agents.utils.env.bootstrap_agents_env"),
    ):
        result = count_pending_memory_observations_activity()

    assert result["ok"] is True
    assert result["pending_count"] == 1
    assert result["oldest_pending_created_at"] is not None


def test_count_observations_by_status_counts_only_matching_rows(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    observations_root = memory_store.memory_observations_dir(memory_store_dir)
    observations_root.mkdir(parents=True)
    pending = observations_root / "pending.md"
    processed = observations_root / "processed.md"
    pending.write_text("pending\n", encoding="utf-8")
    processed.write_text("processed\n", encoding="utf-8")

    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_observation(
            connection,
            observation_id="pending",
            path=str(pending),
            status=OBSERVATION_STATUS_PENDING,
        )
        upsert_observation(
            connection,
            observation_id="processed",
            path=str(processed),
            status=OBSERVATION_STATUS_PROCESSED,
        )

    with open_memory_state(memory_store_dir) as connection:
        assert (
            count_observations_by_status(
                connection,
                status=OBSERVATION_STATUS_PENDING,
            )
            == 1
        )


def test_oldest_observation_created_at_by_status_uses_oldest_pending(
    tmp_path: Path,
) -> None:
    memory_store_dir = tmp_path / "memory"
    observations_root = memory_store.memory_observations_dir(memory_store_dir)
    observations_root.mkdir(parents=True)
    first = observations_root / "first.md"
    second = observations_root / "second.md"
    first.write_text("first\n", encoding="utf-8")
    second.write_text("second\n", encoding="utf-8")

    initialize_memory_state(memory_store_dir)
    with open_memory_state(memory_store_dir) as connection:
        upsert_observation(
            connection,
            observation_id="first",
            path=str(first),
            status=OBSERVATION_STATUS_PENDING,
        )
        first_created_at = oldest_observation_created_at_by_status(
            connection,
            status=OBSERVATION_STATUS_PENDING,
        )
        upsert_observation(
            connection,
            observation_id="second",
            path=str(second),
            status=OBSERVATION_STATUS_PENDING,
        )

    with open_memory_state(memory_store_dir) as connection:
        assert (
            oldest_observation_created_at_by_status(
                connection,
                status=OBSERVATION_STATUS_PENDING,
            )
            == first_created_at
        )


@pytest.mark.asyncio
async def test_threshold_maintenance_workflow_continues_when_pending_remains(
    monkeypatch,
) -> None:
    activity_results = [
        {"ok": True, "skipped": False, "processed_count": 10},
        {"ok": True, "pending_count": MEMORY_MAINTENANCE_PENDING_THRESHOLD},
    ]
    continued = []

    async def fake_execute_activity(*_args, **_kwargs):
        return activity_results.pop(0)

    def fake_continue_as_new(request):
        continued.append(request)
        raise RuntimeError("continued as new")

    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.continue_as_new",
        fake_continue_as_new,
    )
    request = MemoryMaintenanceRequest(
        timeout_seconds=30,
        batch_size=MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE,
    )

    try:
        await MemoryMaintenanceWorkflow().run(request)
    except RuntimeError as error:
        assert str(error) == "continued as new"
    else:
        raise AssertionError("threshold workflow did not continue as new")

    assert continued == [request]


@pytest.mark.asyncio
async def test_threshold_maintenance_workflow_stops_when_pending_below_threshold(
    monkeypatch,
) -> None:
    activity_results = [
        {"ok": True, "skipped": False, "processed_count": 10},
        {"ok": True, "pending_count": MEMORY_MAINTENANCE_PENDING_THRESHOLD - 1},
    ]

    async def fake_execute_activity(*_args, **_kwargs):
        return activity_results.pop(0)

    def fake_continue_as_new(_request):
        raise AssertionError("workflow should not continue as new")

    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.continue_as_new",
        fake_continue_as_new,
    )
    request = MemoryMaintenanceRequest(
        timeout_seconds=30,
        batch_size=MEMORY_MAINTENANCE_DEFAULT_BATCH_SIZE,
    )

    result = await MemoryMaintenanceWorkflow().run(request)

    assert result == {"ok": True, "skipped": False, "processed_count": 10}
    assert activity_results == []


@pytest.mark.asyncio
async def test_pending_observations_trigger_skips_below_threshold(monkeypatch) -> None:
    calls = []

    async def fake_execute_activity(*_args, **_kwargs):
        return {"ok": True, "pending_count": MEMORY_MAINTENANCE_PENDING_THRESHOLD - 1}

    async def fake_start_child_workflow(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.start_child_workflow",
        fake_start_child_workflow,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.logger",
        _fake_workflow_logger(),
    )

    result = await maybe_start_memory_maintenance_for_pending_observations(
        MemoryMaintenanceTriggerRequest(
            timeout_seconds=30,
        ),
        now=datetime.now(UTC),
    )

    assert result == {
        "ok": True,
        "started": False,
        "reason": "below_threshold",
        "pending_count": MEMORY_MAINTENANCE_PENDING_THRESHOLD - 1,
        "oldest_pending_created_at": None,
    }
    assert calls == []


@pytest.mark.asyncio
async def test_pending_observations_trigger_starts_at_threshold(monkeypatch) -> None:
    calls = []

    async def fake_execute_activity(*_args, **_kwargs):
        return {"ok": True, "pending_count": MEMORY_MAINTENANCE_PENDING_THRESHOLD}

    async def fake_start_child_workflow(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.start_child_workflow",
        fake_start_child_workflow,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.logger",
        _fake_workflow_logger(),
    )

    result = await maybe_start_memory_maintenance_for_pending_observations(
        MemoryMaintenanceTriggerRequest(
            timeout_seconds=30,
        ),
        now=datetime.now(UTC),
    )

    assert result == {
        "ok": True,
        "started": True,
        "reason": "pending_threshold",
        "pending_count": MEMORY_MAINTENANCE_PENDING_THRESHOLD,
        "oldest_pending_created_at": None,
    }
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args[0] == MemoryMaintenanceWorkflow.run
    assert kwargs["id"] == MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID


@pytest.mark.asyncio
async def test_pending_observations_trigger_starts_when_oldest_pending_is_stale(
    monkeypatch,
) -> None:
    calls = []
    stale_created_at = (
        datetime.now(UTC) - MEMORY_MAINTENANCE_PENDING_MAX_AGE - timedelta(hours=1)
    ).isoformat()

    async def fake_execute_activity(*_args, **_kwargs):
        return {
            "ok": True,
            "pending_count": 1,
            "oldest_pending_created_at": stale_created_at,
        }

    async def fake_start_child_workflow(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.start_child_workflow",
        fake_start_child_workflow,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.logger",
        _fake_workflow_logger(),
    )

    result = await maybe_start_memory_maintenance_for_pending_observations(
        MemoryMaintenanceTriggerRequest(
            timeout_seconds=30,
        ),
        now=datetime.now(UTC),
    )

    assert result == {
        "ok": True,
        "started": True,
        "reason": "pending_age",
        "pending_count": 1,
        "oldest_pending_created_at": stale_created_at,
    }
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_pending_observations_trigger_handles_duplicate_start(
    monkeypatch,
) -> None:
    async def fake_execute_activity(*_args, **_kwargs):
        return {"ok": True, "pending_count": MEMORY_MAINTENANCE_PENDING_THRESHOLD}

    async def fake_start_child_workflow(*_args, **_kwargs):
        raise WorkflowAlreadyStartedError(
            MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID,
            "MemoryMaintenanceWorkflow",
        )

    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.execute_activity",
        fake_execute_activity,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.start_child_workflow",
        fake_start_child_workflow,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow.workflow.logger",
        _fake_workflow_logger(),
    )

    result = await maybe_start_memory_maintenance_for_pending_observations(
        MemoryMaintenanceTriggerRequest(
            timeout_seconds=30,
        ),
        now=datetime.now(UTC),
    )

    assert result == {
        "ok": True,
        "started": False,
        "reason": "already_running",
    }


@pytest.mark.asyncio
async def test_memory_maintenance_trigger_workflow_runs_pending_observations_trigger(
    monkeypatch,
) -> None:
    async def fake_trigger(request):
        return {
            "ok": True,
            "started": False,
            "reason": "below_threshold",
            "timeout": request.timeout_seconds,
        }

    monkeypatch.setattr(
        "sec_review_agents.memory.maintenance_workflow."
        "maybe_start_memory_maintenance_for_pending_observations",
        fake_trigger,
    )

    result = await MemoryMaintenanceTriggerWorkflow().run(
        MemoryMaintenanceTriggerRequest(timeout_seconds=30)
    )

    assert result == {
        "ok": True,
        "started": False,
        "reason": "below_threshold",
        "timeout": 30,
    }
