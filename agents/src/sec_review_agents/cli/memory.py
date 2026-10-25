import argparse
import asyncio
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

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
from sec_review_agents.utils.env import (
    bootstrap_agents_env,
    env_value,
    int_env,
    load_dotenv_file,
)
from sec_review_agents.workflows.memory.maintenance import (
    MEMORY_MAINTENANCE_WORKFLOW_ID,
    MemoryMaintenanceRequest,
    MemoryMaintenanceWorkflow,
)

DEFAULT_MAINTENANCE_BATCH_SIZE = 10
# Each worker reads the AWS SDK's standard credential variables, while the
# shared development env file names credentials by service role. Keep that
# translation here rather than making role-specific aliases global.
DEV_WORKERS = (
    (
        "execution",
        "sec-review-execution-worker",
        "SEC_REVIEW_EXECUTION_S3_ACCESS_KEY",
        "SEC_REVIEW_EXECUTION_S3_SECRET_KEY",
    ),
    (
        "memory-extraction",
        "sec-review-memory-extraction-worker",
        "SEC_REVIEW_MEMORY_S3_ACCESS_KEY",
        "SEC_REVIEW_MEMORY_S3_SECRET_KEY",
    ),
    (
        "memory-maintenance",
        "sec-review-memory-maintenance-worker",
        "SEC_REVIEW_MEMORY_S3_ACCESS_KEY",
        "SEC_REVIEW_MEMORY_S3_SECRET_KEY",
    ),
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
        description="Run local Memory workers and operate Temporal maintenance."
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

    dev_workers = subcommands.add_parser(
        "dev-workers",
        help="Run the execution, memory extraction, and memory maintenance workers.",
    )
    dev_workers.add_argument(
        "--env-file",
        type=Path,
        help="Load local worker configuration from this dotenv file.",
    )
    dev_workers.set_defaults(handler=_run_dev_workers)

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


def _required_worker_env(environment: dict[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required for local Memory workers.")
    return value


def _dev_worker_environment(
    *,
    access_key_env: str,
    secret_key_env: str,
    maintenance: bool,
) -> dict[str, str]:
    """Build one worker environment from role-specific development settings."""
    environment = dict(os.environ)
    environment["AWS_ACCESS_KEY_ID"] = _required_worker_env(environment, access_key_env)
    environment["AWS_SECRET_ACCESS_KEY"] = _required_worker_env(
        environment, secret_key_env
    )
    for name in (
        "SEC_REVIEW_ARTIFACT_S3_BUCKET",
        "SEC_REVIEW_ARTIFACT_S3_ENDPOINT",
        "AGENT_MEMORY_CATALOG_URL",
        "AGENT_MEMORY_CATALOG_TOKEN",
    ):
        _required_worker_env(environment, name)
    if maintenance:
        # The Catalog permits only one maintainer. Pinning activity concurrency
        # here prevents this convenience launcher from violating that contract.
        environment["TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES"] = "1"
    return environment


def _stop_worker_processes(processes: list[subprocess.Popen[bytes]]) -> None:
    """Terminate a worker group, escalating after a shared grace period."""
    for process in processes:
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 10
    for process in processes:
        if process.poll() is not None:
            continue
        timeout = max(0.0, deadline - time.monotonic())
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _supervise_dev_workers() -> int:
    """Run the local worker set as one lifecycle-managed foreground process."""
    resolved_commands: list[tuple[str, str, str, str]] = []
    for name, command, access_key_env, secret_key_env in DEV_WORKERS:
        executable = shutil.which(command)
        if executable is None:
            raise RuntimeError(f"Local Memory worker command is unavailable: {command}")
        resolved_commands.append((name, executable, access_key_env, secret_key_env))

    stop_requested = False

    def request_stop(_signum: int, _frame: object) -> None:
        nonlocal stop_requested
        stop_requested = True

    previous_handlers = {
        signum: signal.signal(signum, request_stop)
        for signum in (signal.SIGINT, signal.SIGTERM)
    }
    processes: list[subprocess.Popen[bytes]] = []
    try:
        for name, executable, access_key_env, secret_key_env in resolved_commands:
            environment = _dev_worker_environment(
                access_key_env=access_key_env,
                secret_key_env=secret_key_env,
                maintenance=name == "memory-maintenance",
            )
            process = subprocess.Popen(
                [executable],
                env=environment,
                start_new_session=True,
            )
            processes.append(process)
            print(f"started {name} worker pid={process.pid}")

        while not stop_requested:
            for (name, _command, _access, _secret), process in zip(
                resolved_commands, processes, strict=True
            ):
                return_code = process.poll()
                if return_code is not None:
                    print(
                        f"{name} worker exited with status {return_code}.",
                        file=sys.stderr,
                    )
                    # A partial worker set is misleading for local Memory
                    # development, so one exit tears down the entire group.
                    return return_code or 1
            time.sleep(0.2)
        return 0
    finally:
        _stop_worker_processes(processes)
        for signum, previous_handler in previous_handlers.items():
            signal.signal(signum, previous_handler)


def _run_dev_workers(args: argparse.Namespace) -> int:
    """Load optional local settings and supervise all Memory-related workers."""
    if args.env_file is not None:
        if not args.env_file.is_file():
            print(f"Worker env file not found: {args.env_file}", file=sys.stderr)
            return 1
        # An explicitly selected file must win over agents/.env, which is
        # loaded during CLI bootstrap and may target another environment.
        load_dotenv_file(args.env_file, override=True)
    try:
        return _supervise_dev_workers()
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


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
