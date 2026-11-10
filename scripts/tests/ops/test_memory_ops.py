from argparse import Namespace
from unittest.mock import AsyncMock

import pytest
from scripts.ops import memory_ops as memory
from sec_review_agents.entrypoints.memory_maintenance_worker.schedules import (
    MEMORY_MAINTENANCE_SCHEDULE_ID,
)
from sec_review_agents.temporal.config import DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE
from sec_review_agents.workflows.memory.maintenance import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)


def test_cli_exposes_temporal_commands_only() -> None:
    assert memory.parse_args(["maintain"]).command == "maintain"
    with pytest.raises(SystemExit):
        memory.parse_args(["dev-workers"])
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
    assert (
        "Operate Memory maintenance workflows and schedules through Temporal." in output
    )
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


@pytest.mark.parametrize(
    "command", [["maintain"], ["schedules", "maintenance", "ensure"]]
)
def test_temporal_address_defaults_to_memory_stack_and_allows_overrides(
    monkeypatch, command
) -> None:
    monkeypatch.delenv("TEMPORAL_ADDRESS", raising=False)
    assert memory.parse_args(command).temporal_address == "127.0.0.1:17233"

    monkeypatch.setenv("TEMPORAL_ADDRESS", "env-temporal:7233")
    assert memory.parse_args(command).temporal_address == "env-temporal:7233"
    assert (
        memory.parse_args(
            [*command, "--temporal-address", "cli-temporal:7233"]
        ).temporal_address
        == "cli-temporal:7233"
    )


@pytest.mark.asyncio
async def test_manual_maintenance_starts_singleton_workflow(monkeypatch) -> None:
    start = AsyncMock()
    client = AsyncMock()
    client.start_workflow = start
    monkeypatch.setattr(
        memory, "connect_temporal_client", AsyncMock(return_value=client)
    )
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
async def test_manual_reorganization_starts_reorganization_mode(monkeypatch) -> None:
    start = AsyncMock()
    client = AsyncMock()
    client.start_workflow = start
    monkeypatch.setattr(
        memory, "connect_temporal_client", AsyncMock(return_value=client)
    )
    args = Namespace(
        temporal_address="temporal:7233",
        temporal_namespace="default",
        timeout_seconds=30,
        batch_size=5,
        task_queue="memory",
        mode="reorganization",
    )

    assert await memory._start_memory_maintenance_workflow(args) == "started"
    start.assert_awaited_once_with(
        MemoryMaintenanceWorkflow.run,
        MemoryMaintenanceRequest(
            timeout_seconds=30,
            batch_size=5,
            mode="reorganization",
        ),
        id=MEMORY_MAINTENANCE_WORKFLOW_ID,
        task_queue="memory",
    )


@pytest.mark.asyncio
async def test_schedule_ensure_uses_maintenance_contract(monkeypatch) -> None:
    client = object()
    monkeypatch.setattr(
        memory, "connect_temporal_client", AsyncMock(return_value=client)
    )
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


def test_cli_only_exposes_maintenance_schedule() -> None:
    args = memory.parse_args(
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
        memory.parse_args(["schedules", "extraction", "ensure"])


@pytest.mark.parametrize(
    "command,handler",
    [
        (["maintain"], "_run_maintain"),
        (["schedules", "maintenance", "ensure"], "_run_schedule_ensure"),
    ],
)
@pytest.mark.parametrize("cli_override", [False, True])
def test_main_loads_env_before_defaults(
    monkeypatch, tmp_path, command, handler, cli_override
):
    """Operations and workers must select the same stack despite agents/.env settings."""
    env_file = tmp_path / "memory.env"
    env_file.write_text(
        "TEMPORAL_ADDRESS=memory-dev:17233\nTEMPORAL_NAMESPACE=memory-dev\nTEMPORAL_WORKFLOW_TIMEOUT_SECONDS=42\n"
    )

    def bootstrap():
        monkeypatch.setenv("TEMPORAL_ADDRESS", "app-stack:7233")

    monkeypatch.setattr(memory, "bootstrap_agents_env", bootstrap)
    for key in (
        "TEMPORAL_ADDRESS",
        "TEMPORAL_NAMESPACE",
        "TEMPORAL_WORKFLOW_TIMEOUT_SECONDS",
    ):
        monkeypatch.setenv(key, "old")
    captured = []
    monkeypatch.setattr(memory, handler, lambda args: captured.append(args) or 0)
    options = ["--temporal-address", "explicit:7233"] if cli_override else []
    assert memory.main(["--env-file", str(env_file), *command, *options]) == 0
    assert captured[0].temporal_address == (
        "explicit:7233" if cli_override else "memory-dev:17233"
    )
    assert captured[0].temporal_namespace == "memory-dev"
    assert captured[0].timeout_seconds == 42


def test_main_rejects_missing_env_before_dispatch(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(memory, "bootstrap_agents_env", lambda: None)
    connect = AsyncMock()
    monkeypatch.setattr(memory, "connect_temporal_client", connect)
    assert memory.main(["--env-file", str(tmp_path / "missing"), "maintain"]) == 1
    connect.assert_not_awaited()
    assert "Memory env file not found" in capsys.readouterr().err
