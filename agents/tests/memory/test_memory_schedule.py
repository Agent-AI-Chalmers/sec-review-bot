import pytest
from temporalio.client import (
    Client,
    ScheduleActionStartWorkflow,
    ScheduleAlreadyRunningError,
    ScheduleOverlapPolicy,
)

from sec_review_agents.cli.memory import parse_args
from sec_review_agents.memory.extraction_workflow import (
    MemoryExtractionRunRequest,
)
from sec_review_agents.memory.maintenance_workflow import (
    MemoryMaintenanceTriggerRequest,
)
from sec_review_agents.memory.schedule import (
    MEMORY_EXTRACTION_SCHEDULE_DEFAULT_INTERVAL_SECONDS,
    MEMORY_EXTRACTION_SCHEDULE_ID,
    MEMORY_EXTRACTION_WORKFLOW_ID,
    MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS,
    MEMORY_MAINTENANCE_SCHEDULE_ID,
    MEMORY_MAINTENANCE_TRIGGER_WORKFLOW_ID,
    MemoryExtractionScheduleRequest,
    MemoryMaintenanceScheduleRequest,
    build_memory_extraction_schedule,
    build_memory_maintenance_schedule,
    ensure_configured_memory_maintenance_schedule,
    ensure_configured_memory_schedules,
    ensure_default_memory_extraction_schedule,
    ensure_default_memory_maintenance_schedule,
    ensure_memory_extraction_schedule,
    ensure_memory_maintenance_schedule,
)


def test_build_memory_maintenance_schedule_targets_pending_trigger() -> None:
    schedule = build_memory_maintenance_schedule(
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
            task_queue="memory-test",
        )
    )

    assert isinstance(schedule.action, ScheduleActionStartWorkflow)
    assert schedule.action.workflow == "MemoryMaintenanceTriggerWorkflow"
    assert schedule.action.args == [MemoryMaintenanceTriggerRequest(timeout_seconds=30)]
    assert schedule.action.id == MEMORY_MAINTENANCE_TRIGGER_WORKFLOW_ID
    assert schedule.action.task_queue == "memory-test"
    assert schedule.spec.intervals[0].every.total_seconds() == 60
    assert schedule.policy.overlap is ScheduleOverlapPolicy.SKIP


def test_build_memory_extraction_schedule_targets_batch_workflow() -> None:
    schedule = build_memory_extraction_schedule(
        MemoryExtractionScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
            task_queue="memory-test",
        )
    )

    assert isinstance(schedule.action, ScheduleActionStartWorkflow)
    assert schedule.action.workflow == "MemoryExtractionWorkflow"
    assert schedule.action.args == [MemoryExtractionRunRequest(timeout_seconds=30)]
    assert schedule.action.id == MEMORY_EXTRACTION_WORKFLOW_ID
    assert schedule.action.task_queue == "memory-test"
    assert schedule.spec.intervals[0].every.total_seconds() == 60
    assert schedule.policy.overlap is ScheduleOverlapPolicy.SKIP


def test_default_memory_extraction_schedule_is_more_frequent_than_maintenance() -> None:
    assert (
        MEMORY_EXTRACTION_SCHEDULE_DEFAULT_INTERVAL_SECONDS
        < MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS
    )


def test_build_memory_maintenance_schedule_allows_custom_trigger_workflow_id() -> None:
    schedule = build_memory_maintenance_schedule(
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
            workflow_id="memory-trigger-check",
        )
    )

    assert isinstance(schedule.action, ScheduleActionStartWorkflow)
    assert schedule.action.id == "memory-trigger-check"


def test_build_memory_maintenance_schedule_rejects_invalid_intervals() -> None:
    with pytest.raises(ValueError, match="interval_seconds"):
        build_memory_maintenance_schedule(
            MemoryMaintenanceScheduleRequest(
                timeout_seconds=30,
                interval_seconds=0,
            )
        )


class _FakeScheduleHandle:
    def __init__(self) -> None:
        self.updated = False
        self.triggered = False

    async def update(self, updater):
        self.updated = True
        update = updater(object())
        assert update.schedule is not None

    async def trigger(self, *, overlap):
        self.triggered = True
        assert overlap is ScheduleOverlapPolicy.SKIP


class _FakeScheduleClient:
    def __init__(self, *, already_exists: bool = False) -> None:
        self.already_exists = already_exists
        self.created = False
        self.handle = _FakeScheduleHandle()

    async def create_schedule(self, schedule_id, schedule, *, trigger_immediately):
        if self.already_exists:
            raise ScheduleAlreadyRunningError()
        self.created = True
        assert schedule_id in {
            MEMORY_EXTRACTION_SCHEDULE_ID,
            MEMORY_MAINTENANCE_SCHEDULE_ID,
        }
        assert schedule is not None
        assert trigger_immediately is False
        return self.handle

    def get_schedule_handle(self, schedule_id):
        assert schedule_id in {
            MEMORY_EXTRACTION_SCHEDULE_ID,
            MEMORY_MAINTENANCE_SCHEDULE_ID,
        }
        return self.handle


def _temporal_client(client: _FakeScheduleClient) -> Client:
    return client  # type: ignore[return-value]  # Test fake implements the schedule client methods used here.


@pytest.mark.asyncio
async def test_ensure_memory_maintenance_schedule_creates_schedule() -> None:
    client = _FakeScheduleClient()

    result = await ensure_memory_maintenance_schedule(
        _temporal_client(client),
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
        ),
    )

    assert client.created is True
    assert result["action"] == "created"
    assert result["schedule_id"] == MEMORY_MAINTENANCE_SCHEDULE_ID


@pytest.mark.asyncio
async def test_ensure_memory_extraction_schedule_creates_schedule() -> None:
    client = _FakeScheduleClient()

    result = await ensure_memory_extraction_schedule(
        _temporal_client(client),
        MemoryExtractionScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
        ),
    )

    assert client.created is True
    assert result["action"] == "created"
    assert result["schedule_id"] == MEMORY_EXTRACTION_SCHEDULE_ID


@pytest.mark.asyncio
async def test_ensure_memory_maintenance_schedule_updates_existing_schedule() -> None:
    client = _FakeScheduleClient(already_exists=True)

    result = await ensure_memory_maintenance_schedule(
        _temporal_client(client),
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=30,
            interval_seconds=60,
            trigger_immediately=True,
        ),
    )

    assert client.created is False
    assert client.handle.updated is True
    assert client.handle.triggered is True
    assert result["action"] == "updated"
    assert result["trigger_immediately"] is True


def test_memory_schedule_cli_parses_temporal_options() -> None:
    args = parse_args(
        [
            "schedules",
            "maintenance",
            "ensure",
            "--interval-seconds",
            "120",
            "--timeout-seconds",
            "45",
            "--task-queue",
            "memory",
            "--trigger-immediately",
        ]
    )

    assert args.interval_seconds == 120
    assert args.timeout_seconds == 45
    assert args.task_queue == "memory"
    assert args.trigger_immediately is True


@pytest.mark.asyncio
async def test_ensure_default_memory_maintenance_schedule_uses_task_queue(
    monkeypatch,
) -> None:
    calls = []

    async def fake_ensure_schedule(client, request):
        calls.append((client, request))
        return {"ok": True}

    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_memory_maintenance_schedule",
        fake_ensure_schedule,
    )
    client = _FakeScheduleClient()

    result = await ensure_default_memory_maintenance_schedule(
        _temporal_client(client),
        task_queue="memory-test",
    )

    assert result == {"ok": True}
    assert len(calls) == 1
    assert calls[0][0] is client
    assert calls[0][1].task_queue == "memory-test"
    assert calls[0][1].interval_seconds == 60 * 60


@pytest.mark.asyncio
async def test_ensure_default_memory_extraction_schedule_uses_task_queue(
    monkeypatch,
) -> None:
    calls = []

    async def fake_ensure_schedule(client, request):
        calls.append((client, request))
        return {"ok": True}

    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_memory_extraction_schedule",
        fake_ensure_schedule,
    )
    client = _FakeScheduleClient()

    result = await ensure_default_memory_extraction_schedule(
        _temporal_client(client),
        task_queue="memory-test",
    )

    assert result == {"ok": True}
    assert len(calls) == 1
    assert calls[0][0] is client
    assert calls[0][1].task_queue == "memory-test"
    assert (
        calls[0][1].interval_seconds
        == MEMORY_EXTRACTION_SCHEDULE_DEFAULT_INTERVAL_SECONDS
    )


@pytest.mark.asyncio
async def test_ensure_configured_memory_maintenance_schedule_skips_without_memory_dir(
    monkeypatch,
) -> None:
    calls = []

    async def fake_ensure_default_schedule(*_args, **_kwargs):
        calls.append((_args, _kwargs))
        return {"ok": True}

    monkeypatch.delenv("AGENT_MEMORY_DIR", raising=False)
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_default_memory_maintenance_schedule",
        fake_ensure_default_schedule,
    )

    await ensure_configured_memory_maintenance_schedule(
        _temporal_client(_FakeScheduleClient()),
        task_queue="memory-test",
    )

    assert calls == []


@pytest.mark.asyncio
async def test_ensure_configured_memory_maintenance_schedule_skips_when_memory_globally_disabled(
    monkeypatch,
) -> None:
    calls = []

    async def fake_ensure_default_schedule(*_args, **_kwargs):
        calls.append((_args, _kwargs))
        return {"ok": True}

    monkeypatch.setenv("AGENT_MEMORY_ENABLED", "false")
    monkeypatch.setenv("AGENT_MEMORY_DIR", "/tmp/ignored-memory")
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_default_memory_maintenance_schedule",
        fake_ensure_default_schedule,
    )

    await ensure_configured_memory_maintenance_schedule(
        _temporal_client(_FakeScheduleClient()),
        task_queue="memory-test",
    )

    assert calls == []


@pytest.mark.asyncio
async def test_ensure_configured_memory_maintenance_schedule_uses_memory_config(
    tmp_path,
    monkeypatch,
) -> None:
    calls = []

    async def fake_ensure_default_schedule(client, *, task_queue):
        calls.append((client, task_queue))
        return {
            "action": "created",
            "schedule_id": "memory-maintenance-pending-trigger",
            "interval_seconds": 3600,
        }

    monkeypatch.setenv("AGENT_MEMORY_DIR", str(tmp_path / "memory"))
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_default_memory_maintenance_schedule",
        fake_ensure_default_schedule,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.logger",
        type("Logger", (), {"info": lambda *_args, **_kwargs: None})(),
    )
    client = _FakeScheduleClient()

    await ensure_configured_memory_maintenance_schedule(
        _temporal_client(client),
        task_queue="memory-test",
    )

    assert calls == [(client, "memory-test")]


@pytest.mark.asyncio
async def test_ensure_configured_memory_schedules_ensures_extraction_and_maintenance(
    tmp_path,
    monkeypatch,
) -> None:
    calls = []

    async def fake_extraction_schedule(client, *, task_queue):
        calls.append(("extraction", client, task_queue))
        return {
            "action": "created",
            "schedule_id": "memory-extraction-batch",
            "interval_seconds": 600,
        }

    async def fake_maintenance_schedule(client, *, task_queue):
        calls.append(("maintenance", client, task_queue))
        return {
            "action": "created",
            "schedule_id": "memory-maintenance-pending-trigger",
            "interval_seconds": 3600,
        }

    monkeypatch.setenv("AGENT_MEMORY_DIR", str(tmp_path / "memory"))
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_default_memory_extraction_schedule",
        fake_extraction_schedule,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_default_memory_maintenance_schedule",
        fake_maintenance_schedule,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.logger",
        type("Logger", (), {"info": lambda *_args, **_kwargs: None})(),
    )
    client = _FakeScheduleClient()

    await ensure_configured_memory_schedules(
        _temporal_client(client),
        task_queue="memory-test",
    )

    assert calls == [
        ("extraction", client, "memory-test"),
        ("maintenance", client, "memory-test"),
    ]


@pytest.mark.asyncio
async def test_ensure_configured_memory_maintenance_schedule_logs_failure(
    tmp_path,
    monkeypatch,
) -> None:
    warnings = []

    async def fake_ensure_default_schedule(_client, *, task_queue):
        raise RuntimeError("temporal unavailable")

    monkeypatch.setenv("AGENT_MEMORY_DIR", str(tmp_path / "memory"))
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.ensure_default_memory_maintenance_schedule",
        fake_ensure_default_schedule,
    )
    monkeypatch.setattr(
        "sec_review_agents.memory.schedule.logger",
        type(
            "Logger",
            (),
            {
                "warning": lambda _self, event, **fields: warnings.append(
                    (event, fields)
                )
            },
        )(),
    )

    await ensure_configured_memory_maintenance_schedule(
        _temporal_client(_FakeScheduleClient()),
        task_queue="memory-test",
    )

    assert warnings == [
        (
            "memory_maintenance_schedule_ensure_failed",
            {"error": "temporal unavailable"},
        )
    ]
