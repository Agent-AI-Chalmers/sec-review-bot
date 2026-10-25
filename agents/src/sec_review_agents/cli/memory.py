import argparse
import asyncio
import sys

from temporalio.client import Client
from temporalio.exceptions import WorkflowAlreadyStartedError

from sec_review_agents.entrypoints.memory_maintenance_worker.schedules import (
    MEMORY_MAINTENANCE_SCHEDULE_DEFAULT_INTERVAL_SECONDS,
    MEMORY_MAINTENANCE_SCHEDULE_ID,
    MemoryMaintenanceScheduleRequest,
    ensure_memory_maintenance_schedule,
)
from sec_review_agents.temporal.config import (
    DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE,
    DEFAULT_TEMPORAL_ADDRESS,
    DEFAULT_TEMPORAL_NAMESPACE,
    DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
)
from sec_review_agents.utils.env import bootstrap_agents_env, env_value, int_env
from sec_review_agents.workflows.memory.maintenance import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)

DEFAULT_MAINTENANCE_BATCH_SIZE = 10


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
        default=DEFAULT_MEMORY_MAINTENANCE_TASK_QUEUE,
        help="Temporal task queue for the memory maintenance workflow.",
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
    _add_schedule_common_options(parser)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start and repair Temporal memory-maintenance execution."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

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
