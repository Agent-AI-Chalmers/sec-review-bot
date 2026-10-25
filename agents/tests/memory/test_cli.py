from argparse import Namespace
from unittest.mock import AsyncMock

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


def test_cli_exposes_temporal_execution_commands_only() -> None:
    assert memory.parse_args(["maintain"]).command == "maintain"
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
    assert "Start and repair Temporal memory-maintenance execution." in output
    assert "{maintain,schedules}" in output


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
