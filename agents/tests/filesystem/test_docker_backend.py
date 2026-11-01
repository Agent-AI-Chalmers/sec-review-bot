import asyncio
import json
import subprocess
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from deepagents.backends.protocol import (
    ExecuteResponse,
    LsResult,
    SandboxBackendProtocol,
)

from sec_review_agents.filesystem.backend_selection import (
    selected_sandbox_backend_kind,
)
from sec_review_agents.filesystem.docker_backend import (
    DockerRoute,
    DockerSandboxBackend,
)
from sec_review_agents.filesystem.docker_runtime import (
    DockerContainerResource,
    DockerMount,
    arun_docker_command,
    create_docker_container_resource,
    start_container,
)
from sec_review_agents.filesystem.limits import (
    DEFAULT_COMMAND_TIMEOUT_MS,
)
from sec_review_agents.runtime.backend_cleanup import aclose_backend


class _AsyncProcess:
    def __init__(
        self,
        *,
        returncode: int = 0,
        stdout: bytes = b"",
        stderr: bytes = b"",
    ) -> None:
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    async def communicate(self) -> tuple[bytes, bytes]:
        return self._stdout, self._stderr

    def kill(self) -> None:
        pass


def _backend(
    *,
    mounts: list[DockerMount] | None = None,
    routes: list[DockerRoute] | None = None,
    container_name: str = "test-container",
    image: str | None = None,
) -> DockerSandboxBackend:
    resolved_mounts = mounts or []
    container = DockerContainerResource(
        container_name=container_name,
        image=image or "test-image:latest",
        shell="/bin/sh",
        start_command="while true; do sleep 3600; done",
        mounts=resolved_mounts,
        working_directory="/workspace",
        environment={},
        auto_remove=True,
        network_mode="none",
        user=None,
        timeout_ms=None,
    )
    return DockerSandboxBackend(
        container=container,
        routes=(
            routes
            if routes is not None
            else [
                DockerRoute(
                    container_path=mount.container_path,
                    agent_path=mount.container_path,
                    writable=mount.writable,
                )
                for mount in resolved_mounts
            ]
        ),
    )


@pytest.mark.asyncio
async def test_async_docker_command_uses_async_subprocess() -> None:
    process = _AsyncProcess(stdout=b"ok", stderr=b"")

    with patch(
        "asyncio.create_subprocess_exec",
        new_callable=AsyncMock,
        return_value=process,
    ) as create_subprocess_exec:
        result = await arun_docker_command(
            ["docker", "version"],
            expect_success=False,
        )

    create_subprocess_exec.assert_awaited_once_with(
        "docker",
        "version",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert result.stdout == "ok"
    assert result.returncode == 0


@pytest.mark.asyncio
async def test_afinalize_uses_async_docker_shell() -> None:
    """Use the non-blocking Docker API when normalizing mount ownership."""
    mount = DockerMount(
        host_path="/tmp/workspace",
        container_path="/workspace",
        writable=True,
    )
    backend = _backend(mounts=[mount])

    with (
        patch(
            "sec_review_agents.filesystem.docker_backend.docker_runtime.aexec_shell",
            new_callable=AsyncMock,
        ) as async_shell,
        patch(
            "sec_review_agents.filesystem.docker_backend.docker_runtime.exec_shell",
        ) as sync_shell,
    ):
        await backend.afinalize()

    async_shell.assert_awaited_once()
    sync_shell.assert_not_called()


@pytest.mark.asyncio
async def test_aclose_backend_prefers_async_cleanup() -> None:
    """Prefer async cleanup so backend teardown does not block the event loop."""
    aclose = AsyncMock()
    close = Mock()
    backend = SimpleNamespace(
        aclose=aclose,
        close=close,
    )

    await aclose_backend(backend)

    aclose.assert_awaited_once_with()
    close.assert_not_called()


def test_docker_backend_close_finalizes_before_stopping_container() -> None:
    backend = _backend()

    with (
        patch.object(backend, "finalize") as finalize,
        patch.object(backend.container, "close") as close,
    ):
        backend.close()

    finalize.assert_called_once_with()
    close.assert_called_once_with()


def test_docker_backend_close_is_idempotent() -> None:
    backend = _backend()
    backend.container._initialized = True

    with (
        patch.object(backend, "finalize") as finalize,
        patch(
            "sec_review_agents.filesystem.docker_runtime.remove_container"
        ) as remove_container,
    ):
        backend.close()
        backend.close()

    # The second call must skip both the finalize and the removal.
    finalize.assert_called_once_with()
    remove_container.assert_called_once()


@pytest.mark.asyncio
async def test_docker_backend_aclose_finalizes_before_stopping_container() -> None:
    backend = _backend()

    with (
        patch.object(backend, "afinalize", new_callable=AsyncMock) as afinalize,
        patch.object(backend.container, "close") as close,
    ):
        await backend.aclose()

    afinalize.assert_awaited_once_with()
    close.assert_called_once_with()


@pytest.mark.asyncio
async def test_docker_backend_aclose_is_idempotent_after_sync_close() -> None:
    backend = _backend()
    backend.container._initialized = True

    with (
        patch.object(backend, "finalize") as finalize,
        patch.object(backend, "afinalize", new_callable=AsyncMock) as afinalize,
        patch(
            "sec_review_agents.filesystem.docker_runtime.remove_container"
        ) as remove_container,
    ):
        backend.close()
        await backend.aclose()

    finalize.assert_called_once_with()
    afinalize.assert_not_awaited()
    remove_container.assert_called_once()


def test_sandbox_backend_defaults_to_docker() -> None:
    with patch.dict("os.environ", {}, clear=True):
        assert selected_sandbox_backend_kind() == "docker"


def test_sandbox_backend_can_be_forced_to_docker_without_probe() -> None:
    with (
        patch.dict(
            "os.environ",
            {"AGENT_SANDBOX_BACKEND": "docker"},
            clear=True,
        ),
        patch(
            "sec_review_agents.filesystem.docker_runtime.shutil.which",
        ) as which_mock,
    ):
        assert selected_sandbox_backend_kind() == "docker"
        which_mock.assert_not_called()


def test_sandbox_backend_rejects_unknown_mode() -> None:
    with (
        patch.dict("os.environ", {"AGENT_SANDBOX_BACKEND": "host"}, clear=True),
        pytest.raises(
            ValueError,
            match="AGENT_SANDBOX_BACKEND must be docker",
        ),
    ):
        selected_sandbox_backend_kind()


def test_start_container_marks_only_read_only_mounts_readonly(monkeypatch) -> None:
    """Container startup must enforce the repository-owned hardening baseline."""
    monkeypatch.setenv("AGENT_DOCKER_RUN_LABEL", "attempt-test")
    with patch(
        "sec_review_agents.filesystem.docker_runtime.run_docker_command",
    ) as run_command:
        start_container(
            container_name="test-container",
            image="test-image",
            shell="/bin/sh",
            start_command="sleep 1",
            mounts=[
                DockerMount(
                    host_path="/host/read-only",
                    container_path="/readonly",
                    writable=False,
                ),
                DockerMount(
                    host_path="/host/workspace",
                    container_path="/workspace",
                    writable=True,
                ),
            ],
            working_directory="/workspace",
            environment={},
            auto_remove=True,
            network_mode="none",
            user=None,
            timeout_ms=None,
        )

    args = run_command.call_args.args[0]
    assert args[args.index("--label") + 1] == "sec-review.run=attempt-test"
    read_only_mount = next(value for value in args if "dst=/readonly" in value)
    writable_mount = next(value for value in args if "dst=/workspace" in value)
    assert "readonly" in read_only_mount
    assert "readonly" not in writable_mount
    assert args[args.index("--cap-drop") + 1] == "ALL"
    assert "DAC_OVERRIDE" in args
    assert "CHOWN" in args
    assert "no-new-privileges:true" in args
    assert args[args.index("--pids-limit") + 1] == "512"
    assert args[args.index("--memory") + 1] == "4g"
    assert args[args.index("--cpus") + 1] == "2"


@pytest.mark.parametrize(
    ("host_path", "container_path"),
    [
        ("/host/with,comma", "/workspace"),
        ("/host/workspace", "/workspace,with-comma"),
        ("/host/with\0nul", "/workspace"),
        ("/host/workspace", "/workspace\0with-nul"),
    ],
)
def test_docker_mount_rejects_paths_unsafe_for_mount_spec(
    host_path: str,
    container_path: str,
) -> None:
    with pytest.raises(ValueError, match="cannot be safely encoded"):
        DockerMount(
            host_path=host_path,
            container_path=container_path,
            writable=False,
        )


def test_container_resource_uses_shared_default_command_timeout() -> None:
    with patch.dict("os.environ", {}, clear=True):
        container = create_docker_container_resource(
            container_name_prefix="test",
            mounts=[],
            working_directory="/workspace",
            image="test-image",
        )

    assert container.timeout_ms == DEFAULT_COMMAND_TIMEOUT_MS


def test_container_resource_uses_shared_environment_timeout_override() -> None:
    with patch.dict("os.environ", {"AGENT_COMMAND_TIMEOUT_MS": "1234"}, clear=True):
        container = create_docker_container_resource(
            container_name_prefix="test",
            mounts=[],
            working_directory="/workspace",
            image="test-image",
        )

    assert container.timeout_ms == 1234


def test_container_resource_start_is_thread_safe() -> None:
    backend = _backend()
    calls: list[list[str]] = []

    def fake_run_command(args, *, timeout_ms=None, expect_success=True):
        calls.append(args)
        if len(args) >= 2 and args[1] == "run":
            time.sleep(0.05)

    with patch(
        "sec_review_agents.filesystem.docker_runtime.run_docker_command",
        side_effect=fake_run_command,
    ):
        threads = [
            threading.Thread(target=backend.container.ensure_started) for _ in range(2)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    run_calls = [args for args in calls if len(args) >= 2 and args[1] == "run"]
    assert len(run_calls) == 1
    assert backend.container._initialized


def test_container_resource_removes_container_when_start_configuration_fails() -> None:
    backend = _backend(container_name="test-container")

    with (
        patch(
            "sec_review_agents.filesystem.docker_runtime.start_container",
        ) as start_container_mock,
        patch(
            "sec_review_agents.filesystem.docker_runtime.configure_git_safe_directory",
            side_effect=RuntimeError("git config failed"),
        ),
        patch(
            "sec_review_agents.filesystem.docker_runtime.remove_container",
        ) as remove_container_mock,
        pytest.raises(RuntimeError, match="git config failed"),
    ):
        backend.container.ensure_started()

    start_container_mock.assert_called_once()
    assert remove_container_mock.call_count == 2
    assert not backend.container._initialized
    assert not backend.container._closed


def test_default_config_does_not_force_host_uid_user() -> None:
    backend = _backend()
    assert backend.user is None
    assert backend.ownership_uid is not None
    assert backend.ownership_gid is not None
    assert backend.normalize_writable_mount_ownership


def test_backend_keeps_container_handle() -> None:
    backend = _backend()

    assert isinstance(backend.container, DockerContainerResource)
    assert backend.container.container_name == "test-container"
    assert backend.container.timeout_ms == backend.command_timeout_ms


def test_backend_does_not_expose_container_startup_settings() -> None:
    backend = _backend(image="explicit-image:latest")

    assert backend.container.image == "explicit-image:latest"
    assert not hasattr(backend, "image")
    assert not hasattr(backend, "network_mode")
    assert not hasattr(backend, "auto_remove")
    assert not hasattr(backend, "start_command")


@pytest.mark.asyncio
async def test_aexecute_uses_async_docker_cli_runtime() -> None:
    backend = _backend()

    with (
        patch.object(backend.container, "ensure_started") as ensure_started,
        patch(
            "sec_review_agents.filesystem.docker_runtime.aexec_shell",
            new_callable=AsyncMock,
        ) as aexec_shell,
        patch("sec_review_agents.filesystem.docker_runtime.exec_shell") as exec_shell,
    ):
        aexec_shell.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="ok",
            stderr="",
        )

        result = await backend.aexecute("echo ok")

    ensure_started.assert_called_once()
    aexec_shell.assert_awaited_once()
    exec_shell.assert_not_called()
    assert result.output == "ok"
    assert result.exit_code == 0


@pytest.mark.asyncio
async def test_async_filesystem_methods_use_local_async_semantics() -> None:
    backend = _backend(
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=True,
            )
        ]
    )
    commands: list[str] = []

    async def aexecute(
        command: str,
        *,
        timeout: int | None = None,
    ) -> ExecuteResponse:
        commands.append(command)
        return ExecuteResponse(
            output=json.dumps(
                {"path": "/mnt/material/workspace/app.py", "is_dir": False}
            ),
            exit_code=0,
        )

    backend.aexecute = aexecute  # type: ignore[method-assign]

    assert isinstance(backend, SandboxBackendProtocol)
    result = await backend.als("/workspace")

    assert commands
    assert result == LsResult(entries=[{"path": "/workspace/app.py", "is_dir": False}])


def test_routes_define_agent_visible_prefixes() -> None:
    backend = _backend(
        mounts=[
            DockerMount(
                host_path="/tmp/host-workspace",
                container_path="/mnt/material/workspace",
                writable=True,
            )
        ],
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=True,
            )
        ],
    )

    assert backend._is_allowed_path("/workspace/app.py")
    assert backend._is_allowed_path("/workspace/app.py", writable=True)
    assert (
        backend._to_container_path("/workspace/app.py")
        == "/mnt/material/workspace/app.py"
    )
    assert (
        backend.sandbox_path_for_agent_path("/workspace/app.py")
        == "/mnt/material/workspace/app.py"
    )
    assert (
        backend.sandbox_path_for_agent_path(
            "/workspace/app.py",
            require_writable=True,
        )
        == "/mnt/material/workspace/app.py"
    )
    assert (
        backend.sandbox_path_for_agent_path("/workspace/app.py")
        == "/mnt/material/workspace/app.py"
    )
    assert (
        backend.sandbox_path_for_agent_path(
            "/workspace/app.py",
            require_writable=True,
        )
        == "/mnt/material/workspace/app.py"
    )
    assert backend.sandbox_path_for_agent_path("/etc/passwd") is None
    assert (
        backend._to_agent_path("/mnt/material/workspace/app.py") == "/workspace/app.py"
    )


def test_finalize_normalizes_mount_ownership_once_at_backend_end() -> None:
    backend = _backend()
    with patch.object(backend, "_normalize_mount_ownership") as normalize:
        backend.finalize()

    normalize.assert_called_once_with()


def test_tmp_is_container_native_even_without_material_routes() -> None:
    backend = _backend()
    assert (
        backend.sandbox_path_for_agent_path("/tmp/payload", require_writable=True)
        == "/tmp/payload"
    )
    assert not backend.mounts


@pytest.mark.parametrize(
    "container_path,writable", [("/elsewhere", True), ("/tmp", False)]
)
def test_tmp_route_cannot_break_upstream_staging(container_path, writable):
    with pytest.raises(ValueError, match="container-native"):
        _backend(
            routes=[
                DockerRoute(
                    container_path=container_path, agent_path="/tmp", writable=writable
                )
            ]
        )


def test_execute_does_not_normalize_mount_ownership_after_command() -> None:
    backend = _backend(
        mounts=[
            DockerMount(
                host_path="/tmp/host-workspace",
                container_path="/workspace",
                writable=True,
            )
        ],
    )
    calls: list[list[str]] = []

    def fake_run_command(args, *, timeout_ms=None, expect_success=True):
        calls.append(args)

        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        return Result()

    with patch(
        "sec_review_agents.filesystem.docker_runtime.run_docker_command",
        side_effect=fake_run_command,
    ):
        result = backend.execute("echo ok")

    assert result.exit_code == 0
    assert len(calls) == 4
    assert calls[0][1] == "rm"
    assert calls[1][1] == "run"
    assert calls[2][1] == "exec"
    assert "safe.directory" in calls[2][-1]

    execute_call = next(args for args in calls if args[-1] == "echo ok")
    assert execute_call[1] == "exec"
    assert execute_call[-3] == backend.shell
    assert execute_call[-2] == "-c"

    assert not any("chown -R" in args[-1] for args in calls)


def test_execute_does_not_chown_read_only_mounts() -> None:
    backend = _backend(
        mounts=[
            DockerMount(
                host_path="/tmp/host-readonly",
                container_path="/readonly",
                writable=False,
            )
        ],
    )
    calls: list[list[str]] = []

    def fake_run_command(args, *, timeout_ms=None, expect_success=True):
        calls.append(args)

        class Result:
            returncode = 0
            stdout = ""
            stderr = ""

        return Result()

    with patch(
        "sec_review_agents.filesystem.docker_runtime.run_docker_command",
        side_effect=fake_run_command,
    ):
        result = backend.execute("echo ok")

    assert result.exit_code == 0
    assert not any("chown -R" in args[-1] for args in calls)


def test_execute_truncates_output_to_configured_byte_limit() -> None:
    with patch.dict(
        "os.environ",
        {"AGENT_DOCKER_MAX_OUTPUT_BYTES": "5"},
        clear=False,
    ):
        backend = _backend()

    class Result:
        returncode = 0
        stdout = "abc 你好"
        stderr = ""

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.run_docker_command",
            return_value=Result(),
        ),
    ):
        result = backend.execute("echo long")

    assert result.output == "abc "
    assert result.truncated
    assert result.exit_code == 0


def test_execute_timeout_includes_partial_output() -> None:
    backend = _backend()
    timeout = subprocess.TimeoutExpired(
        cmd=["docker", "exec"],
        timeout=1,
        output="partial stdout",
        stderr="partial stderr",
    )

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.exec_shell",
            side_effect=timeout,
        ),
    ):
        result = backend.execute("slow", timeout=1)

    assert "partial stdout" in result.output
    assert "[stderr] partial stderr" in result.output
    assert "Command timed out after 1 seconds." in result.output
    assert result.exit_code == 124


@pytest.mark.asyncio
async def test_aexecute_timeout_includes_partial_output() -> None:
    backend = _backend()
    timeout = subprocess.TimeoutExpired(
        cmd=["docker", "exec"],
        timeout=1,
        output="partial stdout",
        stderr="partial stderr",
    )

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.aexec_shell",
            new_callable=AsyncMock,
        ) as aexec_shell,
    ):
        aexec_shell.side_effect = timeout

        result = await backend.aexecute("slow", timeout=1)

    assert "partial stdout" in result.output
    assert "[stderr] partial stderr" in result.output
    assert "Command timed out after 1 seconds." in result.output
    assert result.exit_code == 124


@pytest.mark.parametrize(
    ("stdout", "stderr", "expected"),
    [
        ("ok", "warn\n", "ok\n[stderr] warn"),
        ("ok\n", "warn\nnext\n", "ok\n\n[stderr] warn\n[stderr] next"),
        ("", "  warn\n", "[stderr] warn"),
        ("", "", "<no output>"),
    ],
)
def test_execute_formats_output_like_deepagents(
    stdout: str, stderr: str, expected: str
) -> None:
    """Match upstream display formatting, including its extra separator after stdout."""
    with patch.dict(
        "os.environ",
        {"AGENT_DOCKER_MAX_OUTPUT_BYTES": "64"},
        clear=False,
    ):
        backend = _backend()

    result_stub = subprocess.CompletedProcess(
        args=["command"], returncode=0, stdout=stdout, stderr=stderr
    )

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.run_docker_command",
            return_value=result_stub,
        ),
    ):
        result = backend.execute("echo ok")

    assert result.output == expected
    assert not result.truncated
    assert result.exit_code == 0


def test_upload_rejects_invalid_paths_without_initializing_container() -> None:
    backend = _backend()

    with patch.object(backend.container, "ensure_started") as ensure_started:
        responses = backend.upload_files([("relative.txt", b"content")])

    ensure_started.assert_not_called()
    assert len(responses) == 1
    assert responses[0].path == "relative.txt"
    assert responses[0].error == "invalid_path"


def test_download_rejects_disallowed_paths_without_initializing_container() -> None:
    backend = _backend(
        mounts=[
            DockerMount(
                host_path="/tmp/host-workspace",
                container_path="/workspace",
                writable=True,
            )
        ],
    )

    with patch.object(backend.container, "ensure_started") as ensure_started:
        responses = backend.download_files(["/etc/passwd"])

    ensure_started.assert_not_called()
    assert len(responses) == 1
    assert responses[0].path == "/etc/passwd"
    assert responses[0].content is None
    assert responses[0].error == "permission_denied"


def test_upload_returns_agent_path_while_using_container_route() -> None:
    backend = _backend(
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=True,
            )
        ],
    )

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.transfer_with_container_helper",
            return_value=subprocess.CompletedProcess([], 0, b"", b""),
        ) as transfer,
    ):
        responses = backend.upload_files([("/workspace/app.py", b"content")])

    assert len(responses) == 1
    assert responses[0].path == "/workspace/app.py"
    assert responses[0].error is None
    assert transfer.call_args.kwargs["script"]
    assert transfer.call_args.kwargs["input_bytes"] == b"content"


def test_download_returns_agent_path_while_using_container_route() -> None:
    backend = _backend(
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=False,
            )
        ],
    )

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.transfer_with_container_helper",
            return_value=subprocess.CompletedProcess([], 0, b"content", b""),
        ) as transfer,
    ):
        responses = backend.download_files(["/workspace/app.py"])

    assert len(responses) == 1
    assert responses[0].path == "/workspace/app.py"
    assert responses[0].content == b"content"
    assert responses[0].error is None
    assert transfer.call_args.kwargs["input_bytes"] is None


def test_download_missing_returns_agent_path() -> None:
    backend = _backend(
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=False,
            )
        ],
    )

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.transfer_with_container_helper",
            return_value=subprocess.CompletedProcess(
                [], 1, b"", b"SEC_REVIEW_TRANSFER_ERROR:file_not_found\n"
            ),
        ),
    ):
        responses = backend.download_files(["/workspace/missing.py"])

    assert responses[0].path == "/workspace/missing.py"
    assert responses[0].error == "file_not_found"


def test_container_resource_has_empty_environment_and_unique_name() -> None:
    """Isolation baseline: containers start with no injected environment and a
    per-run unique name.

    The empty environment is what the sandbox relies on: the setup declaration
    is the only supported way to influence it, so anything that
    leaks in from the host would be an unintended, untracked dependency.
    """
    first = create_docker_container_resource(
        container_name_prefix="test",
        mounts=[],
        working_directory="/workspace",
        image="test-image",
    )
    second = create_docker_container_resource(
        container_name_prefix="test",
        mounts=[],
        working_directory="/workspace",
        image="test-image",
    )

    assert first.environment == {}
    assert first.container_name.startswith("test-")
    assert first.container_name != second.container_name


def test_docker_backend_context_manager_closes_on_normal_exit() -> None:
    backend = _backend()

    with (
        patch.object(backend, "finalize") as finalize,
        patch.object(backend.container, "close") as close,
        backend,
    ):
        pass

    finalize.assert_called_once_with()
    close.assert_called_once_with()


def test_docker_backend_context_manager_surfaces_cleanup_failure_on_normal_exit() -> (
    None
):
    """A failed cleanup on a clean exit must not look like success.

    Nothing else in that path reports a problem, so swallowing the error would tell the caller
    the sandbox was stopped when the container may still be running.
    """
    backend = _backend()

    with (
        patch.object(backend, "finalize"),
        patch.object(
            backend.container, "close", side_effect=RuntimeError("docker daemon gone")
        ),
        pytest.raises(RuntimeError, match="docker daemon gone"),
        backend,
    ):
        pass


def test_docker_backend_context_manager_keeps_the_block_error_when_cleanup_fails() -> (
    None
):
    """The block's exception is what the caller needs; a cleanup failure must not replace it."""
    backend = _backend()

    with (
        patch.object(backend, "finalize"),
        patch.object(
            backend.container, "close", side_effect=RuntimeError("docker daemon gone")
        ),
        pytest.raises(ValueError, match="block failed"),
        backend,
    ):
        raise ValueError("block failed")


def test_docker_backend_logs_cleanup_failure_while_another_exception_propagates() -> (
    None
):
    """A cleanup failure during an exceptional exit is invisible unless it is logged."""
    backend = _backend()

    with (
        patch.object(backend, "finalize"),
        patch.object(
            backend.container, "close", side_effect=RuntimeError("docker daemon gone")
        ),
        patch("sec_review_agents.filesystem.docker_backend._logger") as logger,
        pytest.raises(ValueError, match="block failed"),
        backend,
    ):
        raise ValueError("block failed")

    logger.warning.assert_called_once()
    assert logger.warning.call_args.args[0].startswith("Docker sandbox cleanup failed")


def test_docker_backend_close_can_be_retried_after_a_cleanup_failure() -> None:
    """A failure must leave both the backend and the container resource retryable.

    Mocking `container.close()` would skip the resource's own state machine, which is where the
    failure used to become permanent: it marked itself closed before `remove_container` ran, so
    the retry returned early and the container was never removed.
    """
    backend = _backend()
    backend.container._initialized = True

    with (
        patch(
            "sec_review_agents.filesystem.docker_runtime.remove_container",
            side_effect=[RuntimeError("docker daemon gone"), None],
        ) as remove_container,
        patch.object(backend, "finalize"),
    ):
        with pytest.raises(RuntimeError, match="docker daemon gone"):
            backend.close()

        assert backend._closed is False
        assert backend.container._closed is False

        backend.close()

    assert remove_container.call_count == 2
    assert backend._closed is True
    assert backend.container._closed is True


@pytest.mark.asyncio
async def test_docker_backend_aclose_can_be_retried_after_a_cleanup_failure() -> None:
    """A failed async cleanup must leave every layer retryable, as `close` does."""
    backend = _backend()
    backend.container._initialized = True

    with (
        patch(
            "sec_review_agents.filesystem.docker_runtime.remove_container",
            side_effect=[RuntimeError("docker daemon gone"), None],
        ) as remove_container,
        patch.object(backend, "afinalize", new_callable=AsyncMock),
    ):
        with pytest.raises(RuntimeError, match="docker daemon gone"):
            await backend.aclose()

        assert backend._closed is False
        assert backend.container._closed is False

        await backend.aclose()

    assert remove_container.call_count == 2
    assert backend._closed is True
    assert backend.container._closed is True


def test_docker_backend_close_records_a_completed_removal_when_finalize_fails() -> None:
    """A failed `finalize` must not make a removed container look like it is still running.

    `finalize` runs before the container is removed, so its exception reaches the caller while
    the removal still happens. Leaving the backend open afterwards would have the caller retry
    against a container that is already gone.
    """
    backend = _backend()
    backend.container._initialized = True

    with (
        patch("sec_review_agents.filesystem.docker_runtime.remove_container"),
        patch.object(backend, "finalize", side_effect=RuntimeError("finalize failed")),
        pytest.raises(RuntimeError, match="finalize failed"),
    ):
        backend.close()

    assert backend._closed is True
    assert backend.container.closed is True


@pytest.mark.asyncio
async def test_docker_backend_aclose_records_a_completed_removal_when_afinalize_fails() -> (
    None
):
    """The async path records the same state as the sync one."""
    backend = _backend()
    backend.container._initialized = True

    with (
        patch("sec_review_agents.filesystem.docker_runtime.remove_container"),
        patch.object(
            backend,
            "afinalize",
            new_callable=AsyncMock,
            side_effect=RuntimeError("afinalize failed"),
        ),
        pytest.raises(RuntimeError, match="afinalize failed"),
    ):
        await backend.aclose()

    assert backend._closed is True
    assert backend.container.closed is True


def test_readonly_nested_route_overrides_writable_parent() -> None:
    backend = _backend(
        routes=[
            DockerRoute("/tmp/reference", "/tmp/reference", False),
        ]
    )
    assert (
        backend.sandbox_path_for_agent_path("/tmp/payload", require_writable=True)
        == "/tmp/payload"
    )
    assert (
        backend.sandbox_path_for_agent_path("/tmp/reference/file")
        == "/tmp/reference/file"
    )
    assert (
        backend.sandbox_path_for_agent_path(
            "/tmp/reference/file", require_writable=True
        )
        is None
    )
    assert (
        backend.upload_files([("/tmp/reference/file", b"change")])[0].error
        == "permission_denied"
    )
