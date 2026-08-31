from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.cli import memory as memory_cli
from sec_review_agents.memory import extraction_workflow as memory_extraction_workflow
from sec_review_agents.memory import maintenance_workflow as memory_maintenance_workflow
from sec_review_agents.memory import store as memory_store
from sec_review_agents.memory.maintenance_workflow import (
    MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID,
)
from sec_review_agents.memory.schedule import (
    MEMORY_EXTRACTION_SCHEDULE_ID,
    MEMORY_EXTRACTION_WORKFLOW_ID,
    MEMORY_MAINTENANCE_SCHEDULE_ID,
    MEMORY_MAINTENANCE_TRIGGER_WORKFLOW_ID,
    MemoryExtractionScheduleRequest,
    MemoryMaintenanceScheduleRequest,
)
from sec_review_agents.memory.state import (
    EXTRACTION_JOB_STATUS_PENDING,
    OBSERVATION_STATUS_PENDING,
    OBSERVATION_STATUS_PROCESSED,
    open_memory_state,
    upsert_extraction_job,
    upsert_observation,
)


def test_memory_cli_observations_extract_command_is_removed(
    tmp_path: Path,
) -> None:
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()

    with pytest.raises(SystemExit) as error:
        memory_cli.main(
            [
                "observations",
                "extract",
                str(artifacts),
                "--memory-store-dir",
                str(tmp_path / "memory"),
                "--deployment",
                "test-deployment",
            ]
        )

    assert error.value.code == 2


def test_memory_cli_extraction_list_and_temporal_triggers_e2e(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_store_dir)
    artifacts = tmp_path / "repo-run" / "artifacts"
    artifacts.mkdir(parents=True)
    with open_memory_state(memory_store_dir) as connection:
        upsert_extraction_job(
            connection,
            job_id="repo-review-run-1",
            source_workflow="repo-review",
            run_id="run-1",
            artifact_root_path=str(artifacts),
            status=EXTRACTION_JOB_STATUS_PENDING,
        )
    with patch("sec_review_agents.cli.memory.bootstrap_agents_env"):
        exit_code = memory_cli.main(
            [
                "extraction",
                "list",
                "--status",
                "pending",
                "--memory-store-dir",
                str(memory_store_dir),
            ]
        )

    list_jobs_output = capsys.readouterr().out
    assert exit_code == 0
    assert "repo-review-run-1\tpending" in list_jobs_output
    assert "\trepo-review\trun-1\t" in list_jobs_output
    assert "\tartifacts" in list_jobs_output

    class FakeHandle:
        async def result(self):
            return {"ok": True}

    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[tuple[object, object, dict[str, object]]] = []

        async def start_workflow(self, workflow, request, **kwargs):
            self.calls.append((workflow, request, kwargs))
            return FakeHandle()

    fake_client = FakeClient()

    async def fake_connect(address: str, *, namespace: str) -> FakeClient:
        assert address == "temporal.example:7233"
        assert namespace == "memory-tests"
        return fake_client

    monkeypatch.setattr(memory_cli.Client, "connect", fake_connect)
    exit_code = memory_cli.main(
        [
            "extraction",
            "run",
            "--temporal-address",
            "temporal.example:7233",
            "--temporal-namespace",
            "memory-tests",
            "--task-queue",
            "memory-tests",
            "--workflow-id",
            MEMORY_EXTRACTION_WORKFLOW_ID,
            "--timeout-seconds",
            "45",
            "--batch-size",
            "1",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert (
        f"started memory extraction workflow {MEMORY_EXTRACTION_WORKFLOW_ID}" in output
    )
    assert len(fake_client.calls) == 1
    workflow, request, kwargs = fake_client.calls[0]
    assert workflow is memory_extraction_workflow.MemoryExtractionWorkflow.run
    assert request == memory_extraction_workflow.MemoryExtractionRunRequest(
        timeout_seconds=45,
        batch_size=1,
    )
    assert kwargs["id"] == MEMORY_EXTRACTION_WORKFLOW_ID
    assert kwargs["task_queue"] == "memory-tests"


def test_memory_cli_lists_observations_without_deployment(
    tmp_path: Path,
    capsys,
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_store_dir)
    pending = memory_store.memory_observations_dir(memory_store_dir) / "pending.md"
    processed = memory_store.memory_observations_dir(memory_store_dir) / "processed.md"
    pending.write_text("pending\n", encoding="utf-8")
    processed.write_text("processed\n", encoding="utf-8")
    with open_memory_state(memory_store_dir) as connection:
        upsert_observation(
            connection,
            observation_id="pending-id",
            path=str(pending),
            status=OBSERVATION_STATUS_PENDING,
        )
        upsert_observation(
            connection,
            observation_id="processed-id",
            path=str(processed),
            status=OBSERVATION_STATUS_PROCESSED,
        )

    with patch("sec_review_agents.cli.memory.bootstrap_agents_env"):
        exit_code = memory_cli.main(
            [
                "observations",
                "list",
                "--status",
                "pending",
                "--memory-store-dir",
                str(memory_store_dir),
            ]
        )

    assert exit_code == 0
    output = capsys.readouterr().out
    assert "id\tstatus\tupdated_at\tpath" in output
    assert "pending-id\tpending\t" in output
    assert "observations/pending.md" in output
    assert str(pending) not in output
    assert "processed-id" not in output


def test_memory_cli_list_does_not_initialize_missing_memory_dir(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    memory_store_dir = tmp_path / "missing-memory"

    with patch("sec_review_agents.cli.memory.bootstrap_agents_env"):
        exit_code = memory_cli.main(
            [
                "observations",
                "list",
                "--memory-store-dir",
                str(memory_store_dir),
            ]
        )

    captured = capsys.readouterr()
    assert exit_code == 1
    assert captured.out == ""
    assert "Memory state does not exist:" in captured.err
    assert not memory_store_dir.exists()


def test_memory_cli_maintain_runs_temporal_workflow(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeHandle:
        async def result(self):
            return {"ok": True}

    class FakeClient:
        def __init__(self) -> None:
            self.calls: list[tuple[object, object, dict[str, object]]] = []

        async def start_workflow(self, workflow, request, **kwargs):
            self.calls.append((workflow, request, kwargs))
            return FakeHandle()

    fake_client = FakeClient()

    async def fake_connect(address: str, *, namespace: str) -> FakeClient:
        assert address == "temporal.example:7233"
        assert namespace == "memory-tests"
        return fake_client

    monkeypatch.setattr(memory_cli.Client, "connect", fake_connect)
    exit_code = memory_cli.main(
        [
            "maintain",
            "--temporal-address",
            "temporal.example:7233",
            "--temporal-namespace",
            "memory-tests",
            "--task-queue",
            "memory-tests",
            "--timeout-seconds",
            "60",
            "--batch-size",
            "2",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert (
        f"started memory maintenance workflow {MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID}"
        in output
    )
    assert len(fake_client.calls) == 1
    workflow, request, kwargs = fake_client.calls[0]
    assert workflow is memory_maintenance_workflow.MemoryMaintenanceWorkflow.run
    assert request == memory_maintenance_workflow.MemoryMaintenanceRequest(
        timeout_seconds=60,
        batch_size=2,
    )
    assert kwargs["id"] == MEMORY_MAINTENANCE_THRESHOLD_WORKFLOW_ID
    assert kwargs["task_queue"] == "memory-tests"


def test_memory_cli_maintain_rejects_custom_workflow_id() -> None:
    with pytest.raises(SystemExit) as error:
        memory_cli.main(
            [
                "maintain",
                "--workflow-id",
                "custom-maintenance",
            ]
        )

    assert error.value.code == 2


def test_memory_cli_list_hides_observation_paths_outside_memory_dir(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    memory_store_dir = tmp_path / "memory"
    memory_store.initialize_memory_store(memory_store_dir)
    outside = tmp_path / "outside.md"
    outside.write_text("outside\n", encoding="utf-8")
    with open_memory_state(memory_store_dir) as connection:
        upsert_observation(
            connection,
            observation_id="outside-id",
            path=str(outside),
            status=OBSERVATION_STATUS_PENDING,
        )

    with patch("sec_review_agents.cli.memory.bootstrap_agents_env"):
        exit_code = memory_cli.main(
            [
                "observations",
                "list",
                "--memory-store-dir",
                str(memory_store_dir),
            ]
        )

    assert exit_code == 0
    output = capsys.readouterr().out
    assert "outside-id\tpending\t" in output
    assert "<outside-memory-dir>" in output
    assert str(outside) not in output


def test_memory_cli_connects_and_ensures_maintenance_schedule(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[tuple[object, MemoryMaintenanceScheduleRequest]] = []

    class FakeClient:
        pass

    async def fake_connect(address: str, *, namespace: str) -> FakeClient:
        assert address == "temporal.example:7233"
        assert namespace == "memory-tests"
        return FakeClient()

    async def fake_ensure_schedule(client, request):
        calls.append((client, request))
        return {
            "ok": True,
            "action": "created",
            "schedule_id": request.schedule_id,
            "workflow_id": request.workflow_id,
            "interval_seconds": request.interval_seconds,
            "trigger_immediately": request.trigger_immediately,
        }

    monkeypatch.setattr(memory_cli.Client, "connect", fake_connect)
    monkeypatch.setattr(
        memory_cli,
        "ensure_memory_maintenance_schedule",
        fake_ensure_schedule,
    )

    exit_code = memory_cli.main(
        [
            "schedules",
            "maintenance",
            "ensure",
            "--temporal-address",
            "temporal.example:7233",
            "--temporal-namespace",
            "memory-tests",
            "--interval-seconds",
            "300",
            "--timeout-seconds",
            "45",
            "--task-queue",
            "memory-maintenance",
            "--trigger-immediately",
        ]
    )

    assert exit_code == 0
    output = capsys.readouterr().out
    assert (
        f"created memory maintenance schedule {MEMORY_MAINTENANCE_SCHEDULE_ID} "
        "every 300s"
    ) in output
    assert len(calls) == 1
    _client, request = calls[0]
    assert request == MemoryMaintenanceScheduleRequest(
        timeout_seconds=45,
        interval_seconds=300,
        schedule_id=MEMORY_MAINTENANCE_SCHEDULE_ID,
        workflow_id=MEMORY_MAINTENANCE_TRIGGER_WORKFLOW_ID,
        task_queue="memory-maintenance",
        trigger_immediately=True,
    )


def test_memory_cli_connects_and_ensures_extraction_schedule(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[tuple[object, MemoryExtractionScheduleRequest]] = []

    class FakeClient:
        pass

    async def fake_connect(address: str, *, namespace: str) -> FakeClient:
        assert address == "temporal.example:7233"
        assert namespace == "memory-tests"
        return FakeClient()

    async def fake_ensure_schedule(client, request):
        calls.append((client, request))
        return {
            "ok": True,
            "action": "updated",
            "schedule_id": request.schedule_id,
            "workflow_id": request.workflow_id,
            "interval_seconds": request.interval_seconds,
            "trigger_immediately": request.trigger_immediately,
        }

    monkeypatch.setattr(memory_cli.Client, "connect", fake_connect)
    monkeypatch.setattr(
        memory_cli,
        "ensure_memory_extraction_schedule",
        fake_ensure_schedule,
    )

    exit_code = memory_cli.main(
        [
            "schedules",
            "extraction",
            "ensure",
            "--temporal-address",
            "temporal.example:7233",
            "--temporal-namespace",
            "memory-tests",
            "--interval-seconds",
            "120",
            "--timeout-seconds",
            "45",
            "--task-queue",
            "memory-extraction",
            "--trigger-immediately",
        ]
    )

    assert exit_code == 0
    output = capsys.readouterr().out
    assert (
        f"updated memory extraction schedule {MEMORY_EXTRACTION_SCHEDULE_ID} "
        "every 120s"
    ) in output
    assert len(calls) == 1
    _client, request = calls[0]
    assert request == MemoryExtractionScheduleRequest(
        timeout_seconds=45,
        interval_seconds=120,
        schedule_id=MEMORY_EXTRACTION_SCHEDULE_ID,
        workflow_id=MEMORY_EXTRACTION_WORKFLOW_ID,
        task_queue="memory-extraction",
        trigger_immediately=True,
    )


def test_memory_cli_prints_extraction_schedule_for_custom_schedule_id(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    async def fake_connect(address: str, *, namespace: str) -> object:
        return object()

    async def fake_ensure_schedule(_client, request):
        return {
            "ok": True,
            "action": "updated",
            "schedule_id": request.schedule_id,
            "workflow_id": request.workflow_id,
            "interval_seconds": request.interval_seconds,
            "trigger_immediately": request.trigger_immediately,
        }

    monkeypatch.setattr(memory_cli.Client, "connect", fake_connect)
    monkeypatch.setattr(
        memory_cli,
        "ensure_memory_extraction_schedule",
        fake_ensure_schedule,
    )

    exit_code = memory_cli.main(
        [
            "schedules",
            "extraction",
            "ensure",
            "--schedule-id",
            "custom-extraction-schedule",
            "--interval-seconds",
            "120",
        ]
    )

    assert exit_code == 0
    assert (
        "updated memory extraction schedule custom-extraction-schedule every 120s"
        in capsys.readouterr().out
    )
