import asyncio
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from sec_review_agents.utils.env import env_value

BWRAP_NETWORK_INHERIT = "inherit"
BWRAP_NETWORK_NONE = "none"
BWRAP_BASE_ARGS = (
    "--die-with-parent",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
)
BWRAP_RUNTIME_LIBRARY_PATHS = ("/lib", "/lib64")


@dataclass(frozen=True)
class BwrapMount:
    host_path: Path
    sandbox_path: str
    writable: bool


def default_bwrap_bin() -> str:
    return env_value("AGENT_BWRAP_BIN") or "bwrap"


def basic_bwrap_options(
    *,
    working_directory: str,
    mounts: list[BwrapMount] | tuple[BwrapMount, ...] = (),
    network_mode: str = BWRAP_NETWORK_INHERIT,
) -> list[str]:
    """Build the intentionally small default bwrap sandbox option set."""
    # This is the intentionally small "basic" profile. Network isolation is
    # explicit because it depends on host policy and is not guaranteed to work
    # everywhere.
    if network_mode not in {BWRAP_NETWORK_INHERIT, BWRAP_NETWORK_NONE}:
        raise ValueError("bwrap network_mode must be one of: inherit, none")

    args: list[str] = list(BWRAP_BASE_ARGS)
    if network_mode == BWRAP_NETWORK_NONE:
        args.append("--unshare-net")

    for lib_path in BWRAP_RUNTIME_LIBRARY_PATHS:
        if Path(lib_path).exists():
            args.extend(["--ro-bind", lib_path, lib_path])

    for mount in mounts:
        bind_flag = "--bind" if mount.writable else "--ro-bind"
        args.extend([bind_flag, str(mount.host_path.resolve()), mount.sandbox_path])

    args.extend(["--chdir", working_directory])
    return args


def basic_bwrap_args(
    *,
    bwrap_bin: str,
    working_directory: str,
    mounts: list[BwrapMount] | tuple[BwrapMount, ...] = (),
    network_mode: str = BWRAP_NETWORK_INHERIT,
) -> list[str]:
    """Build a complete bwrap argv from the default option profile."""
    return [
        bwrap_bin,
        *basic_bwrap_options(
            working_directory=working_directory,
            mounts=mounts,
            network_mode=network_mode,
        ),
    ]


def run_bwrap_command(
    *,
    bwrap_bin: str,
    working_directory: str,
    mounts: list[BwrapMount] | tuple[BwrapMount, ...],
    shell: str,
    command: str,
    timeout_seconds: float | None,
    network_mode: str = BWRAP_NETWORK_INHERIT,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            *basic_bwrap_args(
                bwrap_bin=bwrap_bin,
                working_directory=working_directory,
                mounts=mounts,
                network_mode=network_mode,
            ),
            shell,
            "-c",
            command,
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


async def arun_bwrap_command(
    *,
    bwrap_bin: str,
    working_directory: str,
    mounts: list[BwrapMount] | tuple[BwrapMount, ...],
    shell: str,
    command: str,
    timeout_seconds: float | None,
    network_mode: str = BWRAP_NETWORK_INHERIT,
) -> subprocess.CompletedProcess[str]:
    args = [
        *basic_bwrap_args(
            bwrap_bin=bwrap_bin,
            working_directory=working_directory,
            mounts=mounts,
            network_mode=network_mode,
        ),
        shell,
        "-c",
        command,
    ]
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout_seconds,
        )
    except TimeoutError as error:
        process.kill()
        stdout_bytes, stderr_bytes = await process.communicate()
        raise subprocess.TimeoutExpired(
            args,
            timeout_seconds if timeout_seconds is not None else 0,
            output=stdout_bytes.decode(errors="replace"),
            stderr=stderr_bytes.decode(errors="replace"),
        ) from error

    return subprocess.CompletedProcess(
        args=args,
        returncode=process.returncode or 0,
        stdout=stdout_bytes.decode(errors="replace"),
        stderr=stderr_bytes.decode(errors="replace"),
    )


def is_bwrap_runtime_available(
    bwrap_bin: str | None = None,
    *,
    network_mode: str = BWRAP_NETWORK_INHERIT,
) -> bool:
    binary = bwrap_bin or default_bwrap_bin()
    if shutil.which(binary) is None:
        return False
    try:
        result = run_bwrap_command(
            bwrap_bin=binary,
            working_directory="/",
            mounts=(),
            shell="/bin/sh",
            command="printf bwrap-basic-ok",
            timeout_seconds=2,
            network_mode=network_mode,
        )
    except Exception:
        return False
    return result.returncode == 0 and result.stdout == "bwrap-basic-ok"
