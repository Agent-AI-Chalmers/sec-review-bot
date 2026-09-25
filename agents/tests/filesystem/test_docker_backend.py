import asyncio
import base64
import json
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from deepagents.backends.protocol import (
    ExecuteResponse,
    FileUploadResponse,
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
    start_container,
)
from sec_review_agents.filesystem.limits import FilesystemLimits
from sec_review_agents.filesystem.sandbox_file_ops import (
    limits_payload,
    sandbox_file_script_source,
)


def _run_file_script(payload: dict[str, object]) -> dict[str, object]:
    encoded_payload = base64.b64encode(json.dumps(payload).encode("utf-8")).decode(
        "ascii"
    )
    script = sandbox_file_script_source(payload_b64=encoded_payload)
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    payload_data = json.loads(result.stdout)
    assert isinstance(payload_data, dict)
    return payload_data


def _result_list(payload: dict[str, object], key: str) -> list[object]:
    value = payload.get(key)
    return value if isinstance(value, list) else []


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


def test_sandbox_backend_defaults_to_docker_when_available() -> None:
    with (
        patch.dict("os.environ", {}, clear=True),
        patch(
            "sec_review_agents.filesystem.docker_runtime.shutil.which",
            return_value="/usr/bin/docker",
        ),
        patch(
            "sec_review_agents.filesystem.docker_runtime.subprocess.run",
        ) as run_mock,
    ):
        run_mock.return_value.returncode = 0

        assert selected_sandbox_backend_kind() == "docker"


def test_sandbox_backend_auto_falls_back_to_host_when_docker_is_unavailable() -> None:
    with (
        patch.dict("os.environ", {}, clear=True),
        patch(
            "sec_review_agents.filesystem.docker_runtime.shutil.which",
            return_value=None,
        ),
    ):
        assert selected_sandbox_backend_kind() == "local"


def test_sandbox_backend_can_be_forced_to_local() -> None:
    with patch.dict("os.environ", {"AGENT_SANDBOX_BACKEND": "local"}, clear=True):
        assert selected_sandbox_backend_kind() == "local"


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
            match="AGENT_SANDBOX_BACKEND must be one of: auto, docker, local, bwrap",
        ),
    ):
        selected_sandbox_backend_kind()


def test_container_file_script_edits_mixed_newline_content() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        target = Path(tempdir) / "mixed.txt"
        target.write_bytes(b"alpha\r\nbeta\ngamma\r\n")

        result = _run_file_script(
            {
                "op": "edit",
                "path": str(target),
                "old": "alpha\nbeta\n",
                "new": "ALPHA\nBETA\n",
                "replace_all": False,
                "limits": limits_payload(FilesystemLimits()),
            }
        )

        assert result == {"count": 1}
        assert target.read_bytes() == b"ALPHA\r\nBETA\r\ngamma\r\n"


def test_container_file_script_stops_glob_at_result_budget() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        root = Path(tempdir)
        for index in range(5):
            (root / f"file-{index}.py").write_text("x", encoding="utf-8")

        result = _run_file_script(
            {
                "op": "glob",
                "path": str(root),
                "pattern": "*.py",
                "limits": limits_payload(FilesystemLimits(glob_max_results=2)),
            }
        )

        assert result["stop_reason"] == "result_limit"
        assert len(_result_list(result, "matches")) == 2


def test_container_file_script_stops_grep_at_match_budget() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        target = Path(tempdir) / "matches.txt"
        target.write_text("needle\nneedle\nneedle\n", encoding="utf-8")

        result = _run_file_script(
            {
                "op": "grep",
                "path": str(target),
                "pattern": "needle",
                "glob": "**/*",
                "limits": limits_payload(FilesystemLimits(grep_max_matches=2)),
            }
        )

    assert result["stop_reason"] == "match_limit"
    assert len(_result_list(result, "matches")) == 2


def test_container_file_script_does_not_truncate_exact_grep_budget() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        target = Path(tempdir) / "matches.txt"
        target.write_text("needle\nneedle\n", encoding="utf-8")

        result = _run_file_script(
            {
                "op": "grep",
                "path": str(target),
                "pattern": "needle",
                "glob": "**/*",
                "limits": limits_payload(FilesystemLimits(grep_max_matches=2)),
            }
        )

    assert result.get("stop_reason") is None
    assert len(_result_list(result, "matches")) == 2


def test_container_file_script_zero_grep_budget_only_truncates_when_matches_exist() -> (
    None
):
    with tempfile.TemporaryDirectory() as tempdir:
        target = Path(tempdir) / "matches.txt"
        target.write_text("haystack\n", encoding="utf-8")

        no_match_result = _run_file_script(
            {
                "op": "grep",
                "path": str(target),
                "pattern": "needle",
                "glob": "**/*",
                "limits": limits_payload(FilesystemLimits(), grep_max_count=0),
            }
        )
        target.write_text("needle\n", encoding="utf-8")
        match_result = _run_file_script(
            {
                "op": "grep",
                "path": str(target),
                "pattern": "needle",
                "glob": "**/*",
                "limits": limits_payload(FilesystemLimits(), grep_max_count=0),
            }
        )

    assert no_match_result.get("stop_reason") is None
    assert _result_list(no_match_result, "matches") == []
    assert match_result["stop_reason"] == "match_limit"
    assert _result_list(match_result, "matches") == []


def test_start_container_marks_only_read_only_mounts_readonly() -> None:
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
    read_only_mount = next(value for value in args if "dst=/readonly" in value)
    writable_mount = next(value for value in args if "dst=/workspace" in value)
    assert "readonly" in read_only_mount
    assert "readonly" not in writable_mount


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
                {"entries": [{"path": "/mnt/material/workspace/app.py"}]}
            ),
            exit_code=0,
        )

    backend.aexecute = aexecute  # type: ignore[method-assign]

    assert isinstance(backend, SandboxBackendProtocol)
    result = await backend.als("/workspace")

    assert commands
    assert result == LsResult(entries=[{"path": "/workspace/app.py"}])


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

    assert "/mnt/material/workspace" in backend.readable_prefixes
    assert "/mnt/material/workspace" in backend.writable_prefixes
    assert "/workspace" not in backend.readable_prefixes
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


def test_ls_maps_container_paths_back_to_agent_paths() -> None:
    backend = _backend(
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=False,
            )
        ],
    )

    with patch.object(
        backend,
        "_run_file_operation",
        return_value={
            "entries": [
                {
                    "path": "/mnt/material/workspace/app.py",
                    "is_dir": False,
                }
            ]
        },
    ):
        result = backend.ls("/workspace")

    assert result.error is None
    assert result.entries is not None
    assert result.entries[0]["path"] == "/workspace/app.py"


def test_glob_budget_error_uses_filesystem_limits() -> None:
    backend = _backend(
        routes=[
            DockerRoute(
                container_path="/workspace",
                agent_path="/workspace",
                writable=False,
            )
        ],
    )

    with patch.object(
        backend,
        "_run_file_operation",
        return_value={"matches": [], "stop_reason": "result_limit"},
    ):
        result = backend.glob("**/*.py", "/workspace")

    error = result.error or ""
    assert "filesystem resource budget" in error
    assert "result limit" in error


def test_edit_uses_newline_tolerant_docker_file_operation() -> None:
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
        patch.object(
            backend,
            "_run_file_operation",
            return_value={"count": 1},
        ) as operation,
        patch.object(backend, "_normalize_mount_ownership"),
    ):
        result = backend.edit(
            "/workspace/app.py",
            "a\nb",
            "a\nc",
        )

    assert result.error is None
    assert result.path == "/workspace/app.py"
    payload = operation.call_args.args[0]
    assert payload["op"] == "edit"
    assert payload["path"] == "/mnt/material/workspace/app.py"


def test_finalize_normalizes_mount_ownership_once_at_backend_end() -> None:
    backend = _backend()
    with patch.object(backend, "_normalize_mount_ownership") as normalize:
        backend.finalize()

    normalize.assert_called_once_with()


def test_tmp_is_available_only_when_path_binding_exposes_it() -> None:
    backend = _backend()

    assert "/tmp" not in backend.readable_prefixes
    assert "/tmp" not in backend.writable_prefixes
    assert not backend._is_allowed_path("/tmp/app.py")
    assert not backend._is_allowed_path("/tmp/app.py", writable=True)

    backend_with_tmp = _backend(
        routes=[
            DockerRoute(
                container_path="/tmp",
                agent_path="/tmp",
                writable=True,
            )
        ],
    )

    assert "/tmp" in backend_with_tmp.readable_prefixes
    assert "/tmp" in backend_with_tmp.writable_prefixes
    assert backend_with_tmp._is_allowed_path("/tmp/app.py")
    assert backend_with_tmp._is_allowed_path("/tmp/app.py", writable=True)


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


def test_execute_preserves_untruncated_output() -> None:
    with patch.dict(
        "os.environ",
        {"AGENT_DOCKER_MAX_OUTPUT_BYTES": "64"},
        clear=False,
    ):
        backend = _backend()

    class Result:
        returncode = 0
        stdout = "ok"
        stderr = "warn\n"

    with (
        patch.object(backend.container, "ensure_started"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.run_docker_command",
            return_value=Result(),
        ),
    ):
        result = backend.execute("echo ok")

    assert result.output == "ok[stderr] warn\n"
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


def test_upload_returns_agent_path_while_copying_to_container_path() -> None:
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
            "sec_review_agents.filesystem.docker_runtime.exec_shell",
        ),
        patch(
            "sec_review_agents.filesystem.docker_runtime.copy_to_container",
        ) as copy_to_container,
    ):
        responses = backend.upload_files([("/workspace/app.py", b"content")])

    assert len(responses) == 1
    assert responses[0].path == "/workspace/app.py"
    assert responses[0].error is None
    assert (
        copy_to_container.call_args.kwargs["target_path"]
        == "/mnt/material/workspace/app.py"
    )


def test_download_returns_agent_path_while_reading_container_path() -> None:
    backend = _backend(
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=False,
            )
        ],
    )

    def fake_copy_from_container(*, target, **kwargs):
        Path(target).write_bytes(b"content")

    with (
        patch.object(backend.container, "ensure_started"),
        patch.object(backend, "_probe_path_kind", return_value="file"),
        patch(
            "sec_review_agents.filesystem.docker_runtime.copy_from_container",
            side_effect=fake_copy_from_container,
        ) as copy_from_container,
    ):
        responses = backend.download_files(["/workspace/app.py"])

    assert len(responses) == 1
    assert responses[0].path == "/workspace/app.py"
    assert responses[0].content == b"content"
    assert responses[0].error is None
    assert (
        copy_from_container.call_args.kwargs["source_path"]
        == "/mnt/material/workspace/app.py"
    )


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
        patch.object(backend, "_probe_path_kind", return_value="missing"),
    ):
        responses = backend.download_files(["/workspace/missing.py"])

    assert responses[0].path == "/workspace/missing.py"
    assert responses[0].error == "file_not_found"


def test_large_edit_cleans_uploaded_temp_files_after_success() -> None:
    backend = _backend(
        mounts=[
            DockerMount(
                host_path="/tmp/host-workspace",
                container_path="/workspace",
                writable=True,
            )
        ],
    )
    execute_commands: list[str] = []

    class Result:
        output = '{"count": 1}'
        exit_code = 0
        truncated = False

    def fake_execute(command: str, *, timeout=None):
        execute_commands.append(command)
        return Result()

    with (
        patch.object(
            backend,
            "upload_files",
            return_value=[
                FileUploadResponse(path="/workspace/.old", error=None),
                FileUploadResponse(path="/workspace/.new", error=None),
            ],
        ),
        patch.object(backend, "execute", side_effect=fake_execute),
    ):
        result = backend._edit_via_allowed_upload(
            "/workspace/app.py",
            "old",
            "new",
            replace_all=False,
        )

    assert result.error is None
    assert result.occurrences == 1
    assert any(command.startswith("rm -f ") for command in execute_commands)
