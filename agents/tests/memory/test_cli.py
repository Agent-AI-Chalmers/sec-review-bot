from argparse import Namespace
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from sec_review_agents.cli import memory
from sec_review_agents.entrypoints.memory_worker.schedules import (
    MEMORY_MAINTENANCE_SCHEDULE_ID,
)
from sec_review_agents.memory.local_state import (
    OBSERVATION_STATUS_PENDING,
    initialize_memory_state,
    open_memory_state,
    upsert_observation,
)
from sec_review_agents.workflows.memory.maintenance import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)


def test_cli_exposes_observations_maintenance_and_schedule_only() -> None:
    assert memory.parse_args(["observations", "list"]).command == "observations"
    assert memory.parse_args(["maintain"]).command == "maintain"
    assert (
        memory.parse_args(["schedules", "maintenance", "ensure"]).schedule_kind
        == "maintenance"
    )
    with pytest.raises(SystemExit):
        memory.parse_args(["extraction", "list"])


def test_cli_lists_local_observations(tmp_path: Path, capsys) -> None:
    store = tmp_path / "memory"
    store.mkdir()
    initialize_memory_state(store)
    observation = store / "observations" / "one.md"
    observation.parent.mkdir()
    observation.write_text("body", encoding="utf-8")
    with open_memory_state(store) as connection:
        upsert_observation(
            connection,
            observation_id="one",
            path=str(observation),
            status=OBSERVATION_STATUS_PENDING,
        )

    assert memory.main(["observations", "list", "--memory-store-dir", str(store)]) == 0
    output = capsys.readouterr().out
    assert "one\tpending" in output
    assert "observations/one.md" in output


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
        workflow_id=MEMORY_MAINTENANCE_WORKFLOW_ID,
        task_queue="memory",
        trigger_immediately=False,
        schedule_kind="maintenance",
    )

    await memory._ensure_memory_schedule(args)
    assert ensure.await_args is not None
    request = ensure.await_args.args[1]
    assert request.schedule_id == MEMORY_MAINTENANCE_SCHEDULE_ID
    assert request.workflow_id == MEMORY_MAINTENANCE_WORKFLOW_ID
