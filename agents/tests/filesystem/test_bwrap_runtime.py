import asyncio
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sec_review_agents.filesystem.bwrap_runtime import (
    BWRAP_NETWORK_NONE,
    BwrapMount,
    arun_bwrap_command,
    basic_bwrap_args,
    basic_bwrap_options,
    is_bwrap_runtime_available,
)


class _AsyncProcess:
    returncode = 0

    async def communicate(self) -> tuple[bytes, bytes]:
        return b"ok", b""

    def kill(self) -> None:
        pass


def test_basic_args_include_runtime_libs_and_mounts_without_network() -> None:
    args = basic_bwrap_args(
        bwrap_bin="/usr/bin/bwrap",
        working_directory="/workspace",
        mounts=[
            BwrapMount(
                host_path=Path("/tmp/workspace"),
                sandbox_path="/workspace",
                writable=True,
            )
        ],
    )

    assert "--unshare-net" not in args
    assert "--ro-bind" in args
    assert "/usr" in args
    assert "/bin" in args
    assert "--bind" in args
    assert "/workspace" in args
    assert args[-2:] == ["--chdir", "/workspace"]


@pytest.mark.asyncio
async def test_async_bwrap_command_uses_async_subprocess() -> None:
    with patch(
        "asyncio.create_subprocess_exec",
        new_callable=AsyncMock,
        return_value=_AsyncProcess(),
    ) as create_subprocess_exec:
        result = await arun_bwrap_command(
            bwrap_bin="/usr/bin/bwrap",
            working_directory="/workspace",
            mounts=(),
            shell="/bin/sh",
            command="printf ok",
            timeout_seconds=1,
        )

    assert create_subprocess_exec.await_args is not None
    args = create_subprocess_exec.await_args.args
    assert args[0] == "/usr/bin/bwrap"
    assert args[-3:] == ("/bin/sh", "-c", "printf ok")
    create_subprocess_exec.assert_awaited_once_with(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert result.stdout == "ok"
    assert result.returncode == 0


def test_basic_options_exclude_bwrap_binary() -> None:
    options = basic_bwrap_options(
        working_directory="/workspace",
    )

    assert options[0] == "--die-with-parent"
    assert "/usr/bin/bwrap" not in options


def test_basic_args_can_disable_network() -> None:
    args = basic_bwrap_args(
        bwrap_bin="/usr/bin/bwrap",
        working_directory="/workspace",
        network_mode=BWRAP_NETWORK_NONE,
    )

    assert "--unshare-net" in args


def test_basic_args_reject_unknown_network_mode() -> None:
    with pytest.raises(ValueError, match="network_mode"):
        basic_bwrap_args(
            bwrap_bin="/usr/bin/bwrap",
            working_directory="/workspace",
            network_mode="blocked",
        )


def test_probe_uses_basic_runtime_command() -> None:
    with (
        patch("shutil.which", return_value="/usr/bin/bwrap"),
        patch("subprocess.run") as run_mock,
    ):
        run_mock.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="bwrap-basic-ok",
            stderr="",
        )

        assert is_bwrap_runtime_available("/usr/bin/bwrap")

    args = run_mock.call_args.args[0]
    assert "--unshare-net" not in args
    assert args[-3:] == ["/bin/sh", "-c", "printf bwrap-basic-ok"]


def test_probe_can_check_netless_runtime_command() -> None:
    with (
        patch("shutil.which", return_value="/usr/bin/bwrap"),
        patch("subprocess.run") as run_mock,
    ):
        run_mock.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="bwrap-basic-ok",
            stderr="",
        )

        assert is_bwrap_runtime_available(
            "/usr/bin/bwrap",
            network_mode=BWRAP_NETWORK_NONE,
        )

    args = run_mock.call_args.args[0]
    assert "--unshare-net" in args
