import asyncio
import shlex
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from sec_review_agents.filesystem.command_output import combine_command_output
from sec_review_agents.utils.env import env_value, parse_bool_env, parse_int_env

DEFAULT_DOCKER_SANDBOX_IMAGE = "mcr.microsoft.com/devcontainers/universal:6-noble"


def is_docker_runtime_available(docker_bin: str) -> bool:
    """Report current Docker runtime availability for automatic backend selection."""
    # Do not cache this probe: both the Docker daemon and the configured
    # executable are external, mutable state. Reusing an old result can select
    # the wrong backend after a daemon restart or an environment change.
    if shutil.which(docker_bin) is None:
        return False

    try:
        result = subprocess.run(
            [docker_bin, "info", "--format", "{{.ServerVersion}}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return False

    return result.returncode == 0


@dataclass(frozen=True)
class DockerMount:
    host_path: str
    container_path: str
    writable: bool


@dataclass
class DockerContainerResource:
    container_name: str
    image: str
    shell: str
    start_command: str
    mounts: list[DockerMount]
    working_directory: str
    environment: dict[str, str]
    auto_remove: bool
    network_mode: str | None
    user: str | None
    timeout_ms: int | None
    _initialized: bool = field(default=False, init=False, repr=False)
    _closed: bool = field(default=False, init=False, repr=False)
    _lifecycle_lock: threading.Lock = field(
        default_factory=threading.Lock,
        init=False,
        repr=False,
    )

    def ensure_started(self) -> None:
        with self._lifecycle_lock:
            if self._initialized:
                return
            if self._closed:
                raise RuntimeError(
                    f"Docker sandbox {self.container_name} has already been closed."
                )

            remove_container(
                container_name=self.container_name,
                timeout_ms=self.timeout_ms,
            )
            try:
                start_container(
                    container_name=self.container_name,
                    image=self.image,
                    shell=self.shell,
                    start_command=self.start_command,
                    mounts=self.mounts,
                    working_directory=self.working_directory,
                    environment=self.environment,
                    auto_remove=self.auto_remove,
                    network_mode=self.network_mode,
                    user=self.user,
                    timeout_ms=self.timeout_ms,
                )
                configure_git_safe_directory(
                    container_name=self.container_name,
                    shell=self.shell,
                    working_directory=self.working_directory,
                    timeout_ms=self.timeout_ms,
                )
            except Exception:
                remove_container(
                    container_name=self.container_name,
                    timeout_ms=self.timeout_ms,
                )
                raise
            self._initialized = True

    def close(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                return

            self._closed = True
            if not self._initialized:
                return

            remove_container(
                container_name=self.container_name,
                timeout_ms=self.timeout_ms,
            )
            self._initialized = False


def create_docker_container_resource(
    *,
    container_name_prefix: str,
    mounts: list[DockerMount],
    working_directory: str,
    image: str | None,
) -> DockerContainerResource:
    def sanitize_name_segment(value: str | None, fallback: str = "agent") -> str:
        normalized = "".join(
            character.lower() if character.isalnum() or character in "_.-" else "-"
            for character in str(value or "")
        ).strip("-")
        return normalized or fallback

    container_name = (
        f"{sanitize_name_segment(container_name_prefix)}-{uuid.uuid4().hex[:12]}"
    )
    return DockerContainerResource(
        container_name=container_name,
        image=image or env_value("AGENT_DOCKER_IMAGE") or DEFAULT_DOCKER_SANDBOX_IMAGE,
        shell=env_value("AGENT_DOCKER_SHELL") or "/bin/sh",
        start_command="while true; do sleep 3600; done",
        mounts=mounts,
        working_directory=working_directory,
        environment={},
        auto_remove=parse_bool_env(env_value("AGENT_DOCKER_AUTO_REMOVE"), True),
        network_mode=env_value("AGENT_DOCKER_NETWORK_MODE") or "none",
        user=env_value("AGENT_DOCKER_USER") or None,
        timeout_ms=parse_int_env(env_value("AGENT_DOCKER_COMMAND_TIMEOUT_MS")),
    )


def default_docker_bin() -> str:
    return env_value("AGENT_DOCKER_BIN") or "docker"


def run_docker_command(
    args: list[str],
    *,
    timeout_ms: int | None = None,
    expect_success: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        timeout=(timeout_ms / 1000) if timeout_ms else None,
    )

    if expect_success and result.returncode != 0:
        output = combine_command_output(result.stdout, result.stderr)
        raise RuntimeError(output or f"Command failed: {' '.join(args)}")

    return result


async def arun_docker_command(
    args: list[str],
    *,
    timeout_ms: int | None = None,
    expect_success: bool = True,
) -> subprocess.CompletedProcess[str]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(),
            timeout=(timeout_ms / 1000) if timeout_ms else None,
        )
    except TimeoutError as error:
        process.kill()
        stdout_bytes, stderr_bytes = await process.communicate()
        timeout_seconds = (timeout_ms / 1000) if timeout_ms else 0
        raise subprocess.TimeoutExpired(
            args,
            timeout_seconds,
            output=stdout_bytes.decode(errors="replace"),
            stderr=stderr_bytes.decode(errors="replace"),
        ) from error

    stdout = stdout_bytes.decode(errors="replace")
    stderr = stderr_bytes.decode(errors="replace")
    result = subprocess.CompletedProcess(
        args=args,
        returncode=process.returncode or 0,
        stdout=stdout,
        stderr=stderr,
    )

    if expect_success and result.returncode != 0:
        output = combine_command_output(result.stdout, result.stderr)
        raise RuntimeError(output or f"Command failed: {' '.join(args)}")

    return result


def remove_container(
    *,
    container_name: str,
    timeout_ms: int | None,
) -> subprocess.CompletedProcess[str]:
    return run_docker_command(
        [default_docker_bin(), "rm", "-f", container_name],
        timeout_ms=timeout_ms,
        expect_success=False,
    )


def start_container(
    *,
    container_name: str,
    image: str,
    shell: str,
    start_command: str,
    mounts: list[DockerMount],
    working_directory: str,
    environment: dict[str, str],
    auto_remove: bool,
    network_mode: str | None,
    user: str | None,
    timeout_ms: int | None,
) -> subprocess.CompletedProcess[str]:
    args = [default_docker_bin(), "run", "-d"]

    if auto_remove:
        args.append("--rm")

    args.extend(["--name", container_name, "--workdir", working_directory])

    if network_mode:
        args.extend(["--network", network_mode])
    if user:
        args.extend(["--user", user])

    for key, value in environment.items():
        args.extend(["--env", f"{key}={value}"])

    for mount in mounts:
        mount_spec = [
            "type=bind",
            f"src={mount.host_path}",
            f"dst={mount.container_path}",
        ]
        if not mount.writable:
            mount_spec.append("readonly")
        args.extend(["--mount", ",".join(mount_spec)])

    args.extend([image, shell, "-c", start_command])
    return run_docker_command(args, timeout_ms=timeout_ms)


def exec_shell(
    *,
    container_name: str,
    shell: str,
    command: str,
    timeout_ms: int | None,
    expect_success: bool = True,
    working_directory: str | None = None,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    args = [default_docker_bin(), "exec"]
    if working_directory is not None:
        args.extend(["--workdir", working_directory])
    for key, value in (environment or {}).items():
        args.extend(["--env", f"{key}={value}"])
    args.extend([container_name, shell, "-c", command])
    return run_docker_command(
        args,
        timeout_ms=timeout_ms,
        expect_success=expect_success,
    )


async def aexec_shell(
    *,
    container_name: str,
    shell: str,
    command: str,
    timeout_ms: int | None,
    expect_success: bool = True,
    working_directory: str | None = None,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    args = [default_docker_bin(), "exec"]
    if working_directory is not None:
        args.extend(["--workdir", working_directory])
    for key, value in (environment or {}).items():
        args.extend(["--env", f"{key}={value}"])
    args.extend([container_name, shell, "-c", command])
    return await arun_docker_command(
        args,
        timeout_ms=timeout_ms,
        expect_success=expect_success,
    )


def configure_git_safe_directory(
    *,
    container_name: str,
    shell: str,
    working_directory: str,
    timeout_ms: int | None,
) -> subprocess.CompletedProcess[str]:
    """Allow Git commands to inspect the bind-mounted workspace in a container."""
    # Bind-mounted workspaces can trip Git's ownership protection inside the
    # container, which turns basic status/diff checks into harness noise.
    command = (
        "git config --global --add safe.directory " f"{shlex.quote(working_directory)}"
    )
    return exec_shell(
        container_name=container_name,
        shell=shell,
        command=command,
        timeout_ms=timeout_ms,
        expect_success=False,
    )


def copy_to_container(
    *,
    container_name: str,
    source: Path,
    target_path: str,
    timeout_ms: int | None,
) -> subprocess.CompletedProcess[str]:
    return run_docker_command(
        [
            default_docker_bin(),
            "cp",
            str(source),
            f"{container_name}:{target_path}",
        ],
        timeout_ms=timeout_ms,
    )


def copy_from_container(
    *,
    container_name: str,
    source_path: str,
    target: Path,
    timeout_ms: int | None,
) -> subprocess.CompletedProcess[str]:
    return run_docker_command(
        [
            default_docker_bin(),
            "cp",
            f"{container_name}:{source_path}",
            str(target),
        ],
        timeout_ms=timeout_ms,
    )
