import json
import os
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from deepagents.backends.protocol import (
    ExecuteResponse,
    LsResult,
    SandboxBackendProtocol,
)

from sec_review_agents.filesystem.bwrap_backend import (
    BwrapRoute,
    BwrapSandboxBackend,
)
from sec_review_agents.filesystem.bwrap_runtime import (
    BWRAP_NETWORK_INHERIT,
    is_bwrap_runtime_available,
)


def _backend(root: Path, *, writable: bool = True) -> BwrapSandboxBackend:
    return BwrapSandboxBackend(
        routes=[
            BwrapRoute(
                host_path=root,
                agent_path="/workspace",
                writable=writable,
            )
        ],
        bwrap_bin="/usr/bin/bwrap",
        command_timeout_ms=1000,
    )


def test_execute_uses_basic_bwrap_with_network_isolated(tmp_path: Path) -> None:
    backend = _backend(tmp_path)

    with patch("sec_review_agents.filesystem.bwrap_runtime.subprocess.run") as run_mock:
        run_mock.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="ok",
            stderr="",
        )

        result = backend.execute("echo ok")

    args = run_mock.call_args.args[0]
    assert result.output == "ok"
    assert "--unshare-net" in args
    assert "/var/run/docker.sock" not in args
    assert "--ro-bind" in args
    assert "--bind" in args
    assert args[-3:] == ["/bin/sh", "-c", "echo ok"]


def test_execute_can_inherit_network_via_env(tmp_path: Path) -> None:
    with patch.dict(
        "os.environ",
        {"AGENT_BWRAP_NETWORK_MODE": BWRAP_NETWORK_INHERIT},
        clear=False,
    ):
        backend = _backend(tmp_path)

    with patch("sec_review_agents.filesystem.bwrap_runtime.subprocess.run") as run_mock:
        run_mock.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="ok",
            stderr="",
        )

        backend.execute("echo ok")

    args = run_mock.call_args.args[0]
    assert "--unshare-net" not in args


def test_stdio_shell_command_uses_same_bwrap_profile(tmp_path: Path) -> None:
    backend = _backend(tmp_path)

    command, args = backend.stdio_shell_command("exec codegraph serve --mcp")

    assert command == "/usr/bin/bwrap"
    assert args[0] != "/usr/bin/bwrap"
    assert "--unshare-net" in args
    assert "--bind" in args
    assert str(tmp_path.resolve()) in args
    assert "/workspace" in args
    assert args[-3:] == ["/bin/sh", "-c", "exec codegraph serve --mcp"]


@pytest.mark.asyncio
async def test_aexecute_uses_async_bwrap_runtime(tmp_path: Path) -> None:
    backend = _backend(tmp_path)

    with (
        patch(
            "sec_review_agents.filesystem.bwrap_backend.arun_bwrap_command",
            new_callable=AsyncMock,
        ) as arun_bwrap_command,
        patch(
            "sec_review_agents.filesystem.bwrap_backend.run_bwrap_command"
        ) as run_bwrap_command,
    ):
        arun_bwrap_command.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="ok",
            stderr="",
        )

        result = await backend.aexecute("echo ok")

    arun_bwrap_command.assert_awaited_once()
    run_bwrap_command.assert_not_called()
    assert result.output == "ok"
    assert result.exit_code == 0


@pytest.mark.asyncio
async def test_async_filesystem_methods_use_local_async_semantics(
    tmp_path: Path,
) -> None:
    backend = _backend(tmp_path)
    commands: list[str] = []

    async def aexecute(
        command: str,
        *,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        commands.append(command)
        return ExecuteResponse(
            output=json.dumps({"entries": [{"path": "/workspace/app.py"}]}),
            exit_code=0,
        )

    backend.aexecute = aexecute  # type: ignore[method-assign]

    assert isinstance(backend, SandboxBackendProtocol)
    result = await backend.als("/workspace")

    assert commands
    assert result == LsResult(entries=[{"path": "/workspace/app.py"}])


def test_sandbox_path_for_agent_path_respects_writable_bindings(tmp_path: Path) -> None:
    backend = _backend(tmp_path, writable=False)

    assert backend.sandbox_path_for_agent_path("/workspace/app.py") == (
        "/workspace/app.py"
    )
    assert (
        backend.sandbox_path_for_agent_path(
            "/workspace/app.py",
            require_writable=True,
        )
        is None
    )


def test_upload_and_download_use_host_binding(tmp_path: Path) -> None:
    backend = _backend(tmp_path)

    upload = backend.upload_files([("/workspace/nested/payload.bin", b"x" * 128_000)])[
        0
    ]
    download = backend.download_files(["/workspace/nested/payload.bin"])[0]

    assert upload.error is None
    assert (tmp_path / "nested" / "payload.bin").read_bytes() == b"x" * 128_000
    assert download.error is None
    assert download.content == b"x" * 128_000


def test_download_rejects_symlink_escape_from_host_binding(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside.txt"
    root.mkdir()
    outside.write_text("secret", encoding="utf-8")
    (root / "leak.txt").symlink_to(outside)
    backend = _backend(root)

    response = backend.download_files(["/workspace/leak.txt"])[0]

    assert response.error == "permission_denied"
    assert response.content is None


def test_upload_rejects_existing_symlink_target(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside.txt"
    root.mkdir()
    outside.write_text("secret", encoding="utf-8")
    (root / "leak.txt").symlink_to(outside)
    backend = _backend(root)

    response = backend.upload_files([("/workspace/leak.txt", b"changed")])[0]

    assert response.error == "permission_denied"
    assert outside.read_text(encoding="utf-8") == "secret"


def test_upload_rejects_symlink_parent(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (root / "linked").symlink_to(outside, target_is_directory=True)
    backend = _backend(root)

    response = backend.upload_files([("/workspace/linked/payload.txt", b"changed")])[0]

    assert response.error == "permission_denied"
    assert not (outside / "payload.txt").exists()


def test_upload_parent_swap_cannot_redirect_write_outside_route(tmp_path: Path) -> None:
    """A parent rename between resolution and open must not redirect the write."""
    root = tmp_path / "root"
    nested = root / "nested"
    parked = root / "parked"
    outside = tmp_path / "outside"
    nested.mkdir(parents=True)
    outside.mkdir()
    backend = _backend(root)
    original_open = os.open
    swapped = False

    def swap_parent_before_final_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal swapped
        if path == "payload.txt" and not swapped:
            nested.rename(parked)
            nested.symlink_to(outside, target_is_directory=True)
            swapped = True
        return original_open(path, flags, mode, dir_fd=dir_fd)

    with patch(
        "sec_review_agents.filesystem.bwrap_backend.os.open",
        swap_parent_before_final_open,
    ):
        response = backend.upload_files([("/workspace/nested/payload.txt", b"inside")])[
            0
        ]

    assert response.error is None
    assert (parked / "payload.txt").read_bytes() == b"inside"
    assert not (outside / "payload.txt").exists()


def test_download_parent_swap_cannot_redirect_read_outside_route(
    tmp_path: Path,
) -> None:
    """A parent rename between resolution and open must not redirect the read."""
    root = tmp_path / "root"
    nested = root / "nested"
    parked = root / "parked"
    outside = tmp_path / "outside"
    nested.mkdir(parents=True)
    outside.mkdir()
    (nested / "payload.txt").write_bytes(b"inside")
    (outside / "payload.txt").write_bytes(b"outside")
    backend = _backend(root)
    original_open = os.open
    swapped = False

    def swap_parent_before_final_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal swapped
        if path == "payload.txt" and not swapped:
            nested.rename(parked)
            nested.symlink_to(outside, target_is_directory=True)
            swapped = True
        return original_open(path, flags, mode, dir_fd=dir_fd)

    with patch(
        "sec_review_agents.filesystem.bwrap_backend.os.open",
        swap_parent_before_final_open,
    ):
        response = backend.download_files(["/workspace/nested/payload.txt"])[0]

    assert response.error is None
    assert response.content == b"inside"


def test_upload_rejects_read_only_binding(tmp_path: Path) -> None:
    backend = _backend(tmp_path, writable=False)

    response = backend.upload_files([("/workspace/app.py", b"print(1)")])[0]

    assert response.error == "permission_denied"


def test_host_transfer_rejects_fifo_without_waiting(tmp_path: Path) -> None:
    """Host-side transfers must reject FIFOs without waiting for another peer."""
    fifo = tmp_path / "pipe"
    os.mkfifo(fifo)
    backend = _backend(tmp_path)

    upload = backend.upload_files([("/workspace/pipe", b"payload")])[0]
    download = backend.download_files(["/workspace/pipe"])[0]

    assert upload.error == "permission_denied"
    assert download.error == "permission_denied"


def test_bwrap_probe_is_basic_only() -> None:
    with (
        patch("shutil.which", return_value="/usr/bin/bwrap"),
        patch("sec_review_agents.filesystem.bwrap_runtime.subprocess.run") as run_mock,
    ):
        run_mock.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="bwrap-basic-ok",
            stderr="",
        )

        assert is_bwrap_runtime_available("/usr/bin/bwrap")

    args = run_mock.call_args.args[0]
    assert "--unshare-net" in args
    assert args[-3:] == ["/bin/sh", "-c", "printf bwrap-basic-ok"]
