from unittest.mock import AsyncMock

import pytest
from temporalio.client import (
    Client,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleOverlapPolicy,
)
from temporalio.service import RPCError, RPCStatusCode

from sec_review_agents.cli.memory import parse_args
from sec_review_agents.entrypoints.memory_maintenance_worker.schedules import (
    MEMORY_MAINTENANCE_SCHEDULE_ID,
    MemoryMaintenanceScheduleRequest,
    build_memory_maintenance_schedule,
    ensure_configured_memory_schedules,
    ensure_default_memory_maintenance_schedule,
    ensure_memory_maintenance_schedule,
)
from sec_review_agents.workflows.memory.maintenance import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
)


def test_build_schedule_targets_singleton_maintenance_workflow() -> None:
    schedule = build_memory_maintenance_schedule(
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
            task_queue="memory-test",
        )
    )

    assert isinstance(schedule.action, ScheduleActionStartWorkflow)
    assert schedule.action.workflow == "MemoryMaintenanceWorkflow"
    assert schedule.action.args == [
        MemoryMaintenanceRequest(timeout_seconds=30, require_threshold=True)
    ]
    assert schedule.action.id == MEMORY_MAINTENANCE_WORKFLOW_ID
    assert schedule.action.task_queue == "memory-test"
    assert schedule.spec.intervals[0].every.total_seconds() == 60
    assert schedule.policy.overlap is ScheduleOverlapPolicy.SKIP


def test_build_schedule_rejects_invalid_interval() -> None:
    with pytest.raises(ValueError, match="interval_seconds"):
        build_memory_maintenance_schedule(
            MemoryMaintenanceScheduleRequest(
                timeout_seconds=30,
                interval_seconds=0,
            )
        )


class _FakeScheduleHandle:
    def __init__(self, *, delete_error: RPCError | None = None) -> None:
        self.updated = False
        self.triggered = False
        self.deleted = False
        self.delete_error = delete_error

    async def update(self, updater):
        self.updated = True
        assert updater(object()).schedule is not None

    async def trigger(self, *, overlap):
        self.triggered = True
        assert overlap is ScheduleOverlapPolicy.SKIP

    async def delete(self):
        if self.delete_error is not None:
            raise self.delete_error
        self.deleted = True


class _FakeScheduleClient:
    def __init__(
        self,
        *,
        already_exists: bool = False,
        delete_error: RPCError | None = None,
    ) -> None:
        self.already_exists = already_exists
        self.created = False
        self.handle = _FakeScheduleHandle(delete_error=delete_error)
        self.requested_schedule_ids: list[str] = []

    async def create_schedule(self, schedule_id, schedule, *, trigger_immediately):
        if self.already_exists:
            raise ScheduleAlreadyRunningError()
        self.created = True
        assert schedule_id == MEMORY_MAINTENANCE_SCHEDULE_ID
        assert schedule is not None
        assert trigger_immediately is False

    def get_schedule_handle(self, schedule_id):
        self.requested_schedule_ids.append(schedule_id)
        return self.handle


def _client(value: _FakeScheduleClient) -> Client:
    return value  # type: ignore[return-value]


@pytest.mark.asyncio
async def test_ensure_schedule_creates_and_updates() -> None:
    created = _FakeScheduleClient()
    result = await ensure_memory_maintenance_schedule(
        _client(created),
        MemoryMaintenanceScheduleRequest(timeout_seconds=30, interval_seconds=60),
    )
    assert created.created is True
    assert result["action"] == "created"

    updated = _FakeScheduleClient(already_exists=True)
    result = await ensure_memory_maintenance_schedule(
        _client(updated),
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
            trigger_immediately=True,
        ),
    )
    assert result["action"] == "updated"
    assert updated.handle.updated is True
    assert updated.handle.triggered is True


def test_cli_only_exposes_maintenance_schedule() -> None:
    args = parse_args(
        [
            "schedules",
            "maintenance",
            "ensure",
            "--interval-seconds",
            "120",
        ]
    )
    assert args.schedule_kind == "maintenance"
    with pytest.raises(SystemExit):
        parse_args(["schedules", "extraction", "ensure"])


@pytest.mark.asyncio
async def test_default_schedule_uses_worker_task_queue(monkeypatch) -> None:
    calls = []

    async def fake_ensure(client, request):
        calls.append((client, request))
        return {"ok": True}

    monkeypatch.setattr(
        "sec_review_agents.entrypoints.memory_maintenance_worker.schedules.ensure_memory_maintenance_schedule",
        fake_ensure,
    )
    client = _FakeScheduleClient()
    assert await ensure_default_memory_maintenance_schedule(
        _client(client),
        task_queue="memory-test",
    ) == {"ok": True}
    assert calls[0][1].task_queue == "memory-test"


@pytest.mark.asyncio
async def test_configured_schedules_ensure_only_maintenance(monkeypatch) -> None:
    calls = []

    async def fake_ensure(client, *, task_queue):
        calls.append((client, task_queue))
        return {"action": "created", "schedule_id": "memory-maintenance"}

    monkeypatch.setenv("AGENT_MEMORY_CONSUMPTION_ENABLED", "true")
    monkeypatch.setenv("AGENT_MEMORY_CATALOG_URL", "http://memory")
    monkeypatch.setenv("AGENT_MEMORY_CATALOG_TOKEN", "secret")
    monkeypatch.setattr(
        "sec_review_agents.entrypoints.memory_maintenance_worker.schedules.ensure_default_memory_maintenance_schedule",
        fake_ensure,
    )
    client = _FakeScheduleClient()
    await ensure_configured_memory_schedules(_client(client), task_queue="memory-test")
    assert calls == [(client, "memory-test")]


@pytest.mark.asyncio
async def test_configured_schedules_require_catalog_when_processing_is_enabled(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "true")
    monkeypatch.delenv("AGENT_MEMORY_CATALOG_URL", raising=False)

    with pytest.raises(ValueError, match="AGENT_MEMORY_CATALOG_URL"):
        await ensure_configured_memory_schedules(
            _client(_FakeScheduleClient()),
            task_queue="memory-test",
        )


@pytest.mark.asyncio
async def test_configured_schedules_delete_existing_schedules_when_processing_disabled(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")
    ensure = AsyncMock()
    monkeypatch.setattr(
        "sec_review_agents.entrypoints.memory_maintenance_worker.schedules.ensure_default_memory_maintenance_schedule",
        ensure,
    )
    client = _FakeScheduleClient()

    await ensure_configured_memory_schedules(_client(client), task_queue="memory-test")

    assert client.requested_schedule_ids == [
        MEMORY_MAINTENANCE_SCHEDULE_ID,
        "memory-extraction-batch",
        "memory-maintenance-pending-trigger",
    ]
    assert client.handle.deleted is True
    ensure.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabled_schedule_cleanup_ignores_not_found(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")
    client = _FakeScheduleClient(
        delete_error=RPCError("missing", RPCStatusCode.NOT_FOUND, b""),
    )

    await ensure_configured_memory_schedules(_client(client), task_queue="memory-test")

    assert client.requested_schedule_ids == [
        MEMORY_MAINTENANCE_SCHEDULE_ID,
        "memory-extraction-batch",
        "memory-maintenance-pending-trigger",
    ]


@pytest.mark.asyncio
async def test_disabled_schedule_cleanup_propagates_other_rpc_errors(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_MEMORY_PROCESSING_ENABLED", "false")
    error = RPCError("unavailable", RPCStatusCode.UNAVAILABLE, b"")
    client = _FakeScheduleClient(delete_error=error)

    with pytest.raises(RPCError) as captured:
        await ensure_configured_memory_schedules(
            _client(client),
            task_queue="memory-test",
        )

    assert captured.value is error
