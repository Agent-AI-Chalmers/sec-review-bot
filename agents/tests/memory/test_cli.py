from argparse import Namespace
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from sec_review_agents.cli import memory
from sec_review_agents.entrypoints.memory_maintenance_worker.schedules import (
    MEMORY_MAINTENANCE_SCHEDULE_ID,
)
from sec_review_agents.temporal.config import DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE
from sec_review_agents.workflows.memory.maintenance import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)


def test_cli_exposes_worker_and_temporal_commands_only() -> None:
    assert memory.parse_args(["maintain"]).command == "maintain"
    assert memory.parse_args(["dev-workers"]).command == "dev-workers"
    assert (
        memory.parse_args(["schedules", "maintenance", "ensure"]).schedule_kind
        == "maintenance"
    )
    with pytest.raises(SystemExit):
        memory.parse_args(["observations", "list"])
    with pytest.raises(SystemExit):
        memory.parse_args(["extraction", "list"])


def test_cli_help_describes_temporal_execution_not_state_browsing(capsys) -> None:
    with pytest.raises(SystemExit) as exit_info:
        memory.parse_args(["--help"])

    assert exit_info.value.code == 0
    output = capsys.readouterr().out
    assert "Run local Memory workers and operate Temporal maintenance." in output
    assert "{maintain,dev-workers,schedules}" in output


def test_dev_worker_environments_use_role_specific_storage_credentials(
    monkeypatch,
) -> None:
    for name, value in {
        "SEC_REVIEW_EXECUTION_S3_ACCESS_KEY": "execution-key",
        "SEC_REVIEW_EXECUTION_S3_SECRET_KEY": "execution-secret",
        "SEC_REVIEW_MEMORY_S3_ACCESS_KEY": "memory-key",
        "SEC_REVIEW_MEMORY_S3_SECRET_KEY": "memory-secret",
        "SEC_REVIEW_ARTIFACT_S3_BUCKET": "sec-review",
        "SEC_REVIEW_ARTIFACT_S3_ENDPOINT": "http://127.0.0.1:9100",
        "AGENT_MEMORY_CATALOG_URL": "http://127.0.0.1:8092",
        "AGENT_MEMORY_CATALOG_TOKEN": "catalog-token",
    }.items():
        monkeypatch.setenv(name, value)

    execution = memory._dev_worker_environment(
        access_key_env="SEC_REVIEW_EXECUTION_S3_ACCESS_KEY",
        secret_key_env="SEC_REVIEW_EXECUTION_S3_SECRET_KEY",
        maintenance=False,
    )
    maintenance = memory._dev_worker_environment(
        access_key_env="SEC_REVIEW_MEMORY_S3_ACCESS_KEY",
        secret_key_env="SEC_REVIEW_MEMORY_S3_SECRET_KEY",
        maintenance=True,
    )

    assert execution["AWS_ACCESS_KEY_ID"] == "execution-key"
    assert execution["AWS_SECRET_ACCESS_KEY"] == "execution-secret"
    assert maintenance["AWS_ACCESS_KEY_ID"] == "memory-key"
    assert maintenance["AWS_SECRET_ACCESS_KEY"] == "memory-secret"
    assert maintenance["TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES"] == "1"


def test_dev_workers_load_explicit_env_file(monkeypatch, tmp_path: Path) -> None:
    env_file = tmp_path / "memory.env"
    env_file.write_text("AGENT_MEMORY_CATALOG_TOKEN=local-token\n", encoding="utf-8")
    monkeypatch.setenv("AGENT_MEMORY_CATALOG_TOKEN", "agents-env-token")
    monkeypatch.setattr(memory, "_supervise_dev_workers", lambda: 0)

    assert memory._run_dev_workers(Namespace(env_file=env_file)) == 0
    assert memory.os.environ["AGENT_MEMORY_CATALOG_TOKEN"] == "local-token"


def test_dev_worker_failure_stops_remaining_workers(monkeypatch) -> None:
    for name, value in {
        "SEC_REVIEW_EXECUTION_S3_ACCESS_KEY": "execution-key",
        "SEC_REVIEW_EXECUTION_S3_SECRET_KEY": "execution-secret",
        "SEC_REVIEW_MEMORY_S3_ACCESS_KEY": "memory-key",
        "SEC_REVIEW_MEMORY_S3_SECRET_KEY": "memory-secret",
        "SEC_REVIEW_ARTIFACT_S3_BUCKET": "sec-review",
        "SEC_REVIEW_ARTIFACT_S3_ENDPOINT": "http://127.0.0.1:9100",
        "AGENT_MEMORY_CATALOG_URL": "http://127.0.0.1:8092",
        "AGENT_MEMORY_CATALOG_TOKEN": "catalog-token",
    }.items():
        monkeypatch.setenv(name, value)

    execution = Mock(pid=101)
    execution.poll.return_value = 7
    extraction = Mock(pid=102)
    extraction.poll.return_value = None
    maintenance = Mock(pid=103)
    maintenance.poll.return_value = None
    processes = iter((execution, extraction, maintenance))

    monkeypatch.setattr(memory.shutil, "which", lambda command: f"/bin/{command}")
    monkeypatch.setattr(
        memory.subprocess, "Popen", lambda *args, **kwargs: next(processes)
    )
    monkeypatch.setattr(memory.signal, "signal", lambda *args: memory.signal.SIG_DFL)

    assert memory._supervise_dev_workers() == 7
    execution.terminate.assert_not_called()
    extraction.terminate.assert_called_once_with()
    maintenance.terminate.assert_called_once_with()


def test_temporal_commands_default_to_maintenance_task_queue() -> None:
    assert (
        memory.parse_args(["maintain"]).task_queue
        == DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE
    )
    assert (
        memory.parse_args(["schedules", "maintenance", "ensure"]).task_queue
        == DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE
    )


@pytest.mark.asyncio
async def test_manual_maintenance_starts_singleton_workflow(monkeypatch) -> None:
    start = AsyncMock()
    client = AsyncMock()
    client.start_workflow = start
    monkeypatch.setattr(memory.Client, "connect", AsyncMock(return_value=client))
    args = Namespace(
        temporal_address="temporal:7233",
        temporal_namespace="default",
        timeout_seconds=30,
        batch_size=5,
        task_queue="memory",
    )

    assert await memory._start_memory_maintenance_workflow(args) == "started"
    start.assert_awaited_once_with(
        MemoryMaintenanceWorkflow.run,
        MemoryMaintenanceRequest(timeout_seconds=30, batch_size=5),
        id=MEMORY_MAINTENANCE_WORKFLOW_ID,
        task_queue="memory",
    )


@pytest.mark.asyncio
async def test_schedule_ensure_uses_maintenance_contract(monkeypatch) -> None:
    client = object()
    monkeypatch.setattr(memory.Client, "connect", AsyncMock(return_value=client))
    ensure = AsyncMock(
        return_value={
            "action": "created",
            "schedule_id": MEMORY_MAINTENANCE_SCHEDULE_ID,
            "interval_seconds": 60,
        }
    )
    monkeypatch.setattr(memory, "ensure_memory_maintenance_schedule", ensure)
    args = Namespace(
        temporal_address="temporal:7233",
        temporal_namespace="default",
        timeout_seconds=30,
        interval_seconds=60,
        schedule_id=MEMORY_MAINTENANCE_SCHEDULE_ID,
        task_queue="memory",
        trigger_immediately=False,
        schedule_kind="maintenance",
    )

    await memory._ensure_memory_schedule(args)
    assert ensure.await_args is not None
    request = ensure.await_args.args[1]
    assert request.schedule_id == MEMORY_MAINTENANCE_SCHEDULE_ID
    assert not hasattr(request, "workflow_id")
