"""Launch execution, extraction, and maintenance workers for local development."""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from sec_review_agents.utils.env import bootstrap_agents_env, load_dotenv_file

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


def _required_worker_env(environment: dict[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required for local development workers.")
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
            raise RuntimeError(
                f"Local development worker command is unavailable: {command}"
            )
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
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        help="Load local worker configuration from this dotenv file.",
    )
    args = parser.parse_args(argv)
    bootstrap_agents_env()
    return _run_dev_workers(args)


if __name__ == "__main__":
    raise SystemExit(main())
