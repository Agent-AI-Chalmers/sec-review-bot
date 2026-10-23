import argparse
import asyncio
import sys
from pathlib import Path

from temporalio.client import Client
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.memory.maintenance_workflow import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)
from sec_review_agents.memory.schedule import (
    MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS,
    MEMORY_MAINTENANCE_SCHEDULE_ID,
    MemoryMaintenanceScheduleRequest,
    ensure_memory_maintenance_schedule,
)
from sec_review_agents.memory.state import (
    MEMORY_STATE_FILENAME,
    OBSERVATION_STATUSES,
    ObservationRow,
    fetch_all_observations,
    fetch_observations_by_status,
    open_memory_state,
)
from sec_review_agents.memory.store import (
    AGENT_MEMORY_DIR_ENV,
    resolve_memory_store_dir,
)
from sec_review_agents.temporal.config import (
    DEFAULT_MEMORY_TASK_QUEUE,
    DEFAULT_TEMPORAL_ADDRESS,
    DEFAULT_TEMPORAL_NAMESPACE,
    DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
)
from sec_review_agents.utils.env import bootstrap_agents_env, env_value, int_env

DEFAULT_MAINTENANCE_BATCH_SIZE = 10


def _add_memory_store_dir(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--memory-store-dir",
        type=Path,
        default=None,
        help=("Writable memory store. Overrides " f"{AGENT_MEMORY_DIR_ENV}."),
    )


def _add_temporal_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=int_env(
            "TEMPORAL_WORKFLOW_TIMEOUT_SECONDS",
            DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
            minimum=1,
        ),
        help="Timeout passed to memory workflow activities.",
    )
    parser.add_argument(
        "--task-queue",
        default=DEFAULT_MEMORY_TASK_QUEUE,
        help="Temporal task queue for the memory workflow.",
    )
    parser.add_argument(
        "--temporal-address",
        default=env_value("TEMPORAL_ADDRESS") or DEFAULT_TEMPORAL_ADDRESS,
        help="Temporal server address.",
    )
    parser.add_argument(
        "--temporal-namespace",
        default=env_value("TEMPORAL_NAMESPACE") or DEFAULT_TEMPORAL_NAMESPACE,
        help="Temporal namespace.",
    )


def _add_schedule_common_options(parser: argparse.ArgumentParser) -> None:
    _add_temporal_options(parser)
    parser.add_argument(
        "--trigger-immediately",
        action="store_true",
        help="Trigger one workflow run immediately after creating or updating.",
    )


def _add_maintenance_schedule_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS,
        help="How often to check pending memory observations.",
    )
    parser.add_argument(
        "--schedule-id",
        default=MEMORY_MAINTENANCE_SCHEDULE_ID,
        help="Temporal maintenance schedule id to create or update.",
    )
    parser.add_argument(
        "--workflow-id",
        default=MEMORY_MAINTENANCE_WORKFLOW_ID,
        help="Workflow id used by scheduled maintenance runs.",
    )
    _add_schedule_common_options(parser)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Operate security-review experience memory."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    observations = subcommands.add_parser(
        "observations",
        help="Inspect durable memory observations.",
    )
    observation_commands = observations.add_subparsers(
        dest="observation_command",
        required=True,
    )

    list_observations = observation_commands.add_parser(
        "list",
        help="List observation ledger rows without reading observation bodies.",
    )
    _add_memory_store_dir(list_observations)
    list_observations.add_argument(
        "--status",
        choices=sorted(OBSERVATION_STATUSES),
        default=None,
        help="Filter observations by status.",
    )
    list_observations.set_defaults(handler=_run_list_observations)

    maintain = subcommands.add_parser(
        "maintain",
        help="Start the Temporal workflow that maintains pending observations.",
    )
    maintain.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_MAINTENANCE_BATCH_SIZE,
        help=(
            "Maximum pending observations to process in this run. "
            "Use this to keep operational maintenance reviews small. "
            f"Defaults to {DEFAULT_MAINTENANCE_BATCH_SIZE}."
        ),
    )
    _add_temporal_options(maintain)
    maintain.set_defaults(handler=_run_maintain)

    schedules = subcommands.add_parser(
        "schedules",
        help="Repair Temporal schedules used by memory automation.",
    )
    schedule_kinds = schedules.add_subparsers(dest="schedule_kind", required=True)

    maintenance_schedule = schedule_kinds.add_parser(
        "maintenance",
        help=(
            "Repair the schedule that checks pending observations and starts "
            "maintenance when thresholds are reached."
        ),
    )
    maintenance_schedule_actions = maintenance_schedule.add_subparsers(
        dest="schedule_action",
        required=True,
    )
    maintenance_schedule_ensure = maintenance_schedule_actions.add_parser(
        "ensure",
        help="Create or update the memory maintenance trigger schedule.",
    )
    _add_maintenance_schedule_options(maintenance_schedule_ensure)
    maintenance_schedule_ensure.set_defaults(handler=_run_schedule_ensure)

    return parser.parse_args(argv)


def _display_memory_path(path: Path | str, *, memory_store_dir: Path) -> str:
    candidate = Path(path)
    try:
        return candidate.expanduser().resolve().relative_to(memory_store_dir).as_posix()
    except ValueError:
        # Keep the operator-visible ledger output useful without exposing host paths.
        return "<outside-memory-dir>"


def _print_observation_rows(
    rows: list[ObservationRow], *, memory_store_dir: Path
) -> None:
    if not rows:
        print("No observations.")
        return
    print("id\tstatus\tupdated_at\tpath")
    for row in rows:
        display_path = _display_memory_path(
            row.path,
            memory_store_dir=memory_store_dir,
        )
        print(f"{row.observation_id}\t{row.status}\t{row.updated_at}\t{display_path}")


def _run_list_observations(args: argparse.Namespace) -> int:
    memory_store_dir = resolve_memory_store_dir(args.memory_store_dir, required=True)
    assert memory_store_dir is not None
    if not (memory_store_dir / MEMORY_STATE_FILENAME).is_file():
        print(f"Memory state does not exist: {memory_store_dir}", file=sys.stderr)
        return 1
    with open_memory_state(memory_store_dir) as connection:
        rows = (
            fetch_observations_by_status(connection, status=args.status)
            if args.status
            else fetch_all_observations(connection)
        )
    _print_observation_rows(rows, memory_store_dir=memory_store_dir)
    return 0


def _run_maintain(args: argparse.Namespace) -> int:
    if args.batch_size is not None and args.batch_size < 1:
        print("--batch-size must be positive.", file=sys.stderr)
        return 1
    if args.timeout_seconds < 1:
        print("--timeout-seconds must be positive.", file=sys.stderr)
        return 1
    try:
        action = asyncio.run(_start_memory_maintenance_workflow(args))
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"{action} memory maintenance workflow {MEMORY_MAINTENANCE_WORKFLOW_ID}")
    return 0


async def _start_memory_maintenance_workflow(args: argparse.Namespace) -> str:
    client = await Client.connect(
        args.temporal_address,
        namespace=args.temporal_namespace,
    )
    request = MemoryMaintenanceRequest(
        timeout_seconds=args.timeout_seconds,
        batch_size=args.batch_size,
    )
    try:
        await client.start_workflow(
            MemoryMaintenanceWorkflow.run,
            request,
            id=MEMORY_MAINTENANCE_WORKFLOW_ID,
            task_queue=args.task_queue,
        )
    except WorkflowAlreadyStartedError:
        return "already-running"
    return "started"


def _run_schedule_ensure(args: argparse.Namespace) -> int:
    if args.interval_seconds < 1:
        print("--interval-seconds must be positive.", file=sys.stderr)
        return 1
    if args.timeout_seconds < 1:
        print("--timeout-seconds must be positive.", file=sys.stderr)
        return 1
    try:
        result = asyncio.run(_ensure_memory_schedule(args))
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    print(
        "{action} memory {schedule_kind} schedule {schedule_id} "
        "every {interval_seconds}s".format(
            action=result["action"],
            schedule_kind=args.schedule_kind,
            schedule_id=result["schedule_id"],
            interval_seconds=result["interval_seconds"],
        )
    )
    return 0


async def _ensure_memory_schedule(args: argparse.Namespace) -> dict[str, object]:
    client = await Client.connect(
        args.temporal_address,
        namespace=args.temporal_namespace,
    )
    return await ensure_memory_maintenance_schedule(
        client,
        MemoryMaintenanceScheduleRequest(
            timeout_seconds=args.timeout_seconds,
            interval_seconds=args.interval_seconds,
            schedule_id=args.schedule_id,
            workflow_id=args.workflow_id,
            task_queue=args.task_queue,
            trigger_immediately=args.trigger_immediately,
        ),
    )


def main(argv: list[str] | None = None) -> int:
    bootstrap_agents_env()
    args = parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
