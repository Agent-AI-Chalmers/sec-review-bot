import subprocess
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.bwrap_backend import (
    BwrapRoute,
    BwrapSandboxBackend,
)
from sec_review_agents.filesystem.docker_backend import (
    DockerRoute,
    DockerSandboxBackend,
)
from sec_review_agents.filesystem.docker_runtime import DockerContainerResource
from sec_review_agents.filesystem.material_views import (
    workspace_view,
)
from sec_review_agents.mcp.codegraph import codegraph_mcp_connections_for_backend


def _docker_backend(*, writable: bool = True) -> DockerSandboxBackend:
    container = DockerContainerResource(
        container_name="test-container",
        image="test-image:latest",
        shell="/bin/sh",
        start_command="while true; do sleep 3600; done",
        mounts=[],
        working_directory="/workspace",
        environment={},
        auto_remove=True,
        network_mode="none",
        user=None,
        timeout_ms=None,
    )
    return DockerSandboxBackend(
        container=container,
        routes=[
            DockerRoute(
                container_path="/mnt/material/workspace",
                agent_path="/workspace",
                writable=writable,
            )
        ],
    )


def test_skips_non_docker_backend_without_legacy_gate() -> None:
    with patch(
        "sec_review_agents.mcp.codegraph.log_diagnostic",
    ) as log_diagnostic:
        connections = codegraph_mcp_connections_for_backend(object())

    assert connections == {}
    log_diagnostic.assert_called_with(
        "codegraph_mcp_skipped",
        reason="unsupported_backend",
    )


def test_docker_backend_attempts_prepare_without_legacy_gate() -> None:
    backend = _docker_backend()

    with (
        patch.object(backend.container, "ensure_started") as ensure_started,
        patch.object(
            backend,
            "execute",
            return_value=Mock(exit_code=1, output="missing"),
        ) as execute,
    ):
        connections = codegraph_mcp_connections_for_backend(backend)

    assert connections == {}
    ensure_started.assert_called_once_with()
    execute.assert_called_once()


def test_skips_non_docker_backend_when_enabled() -> None:
    with patch(
        "sec_review_agents.mcp.codegraph.log_diagnostic",
    ) as log_diagnostic:
        connections = codegraph_mcp_connections_for_backend(object())

    assert connections == {}
    log_diagnostic.assert_called_with(
        "codegraph_mcp_skipped",
        reason="unsupported_backend",
    )


def test_skips_read_only_workspace() -> None:
    backend = _docker_backend(writable=False)

    with (
        patch(
            "sec_review_agents.mcp.codegraph.log_diagnostic",
        ) as log_diagnostic,
        patch.object(
            backend.container,
            "ensure_started",
        ) as ensure_started,
    ):
        connections = codegraph_mcp_connections_for_backend(backend)

    assert connections == {}
    ensure_started.assert_called_once_with()
    log_diagnostic.assert_called_with(
        "codegraph_mcp_skipped",
        reason="index_not_available",
    )


def test_prepares_index_and_returns_docker_exec_mcp_connection() -> None:
    backend = _docker_backend()
    execute_result = Mock(exit_code=0, output="")

    with (
        patch.object(backend.container, "ensure_started") as ensure_started,
        patch.object(backend, "execute", return_value=execute_result) as execute,
        patch(
            "sec_review_agents.filesystem.docker_runtime.default_docker_bin",
            return_value="/usr/bin/docker",
        ),
    ):
        connections = codegraph_mcp_connections_for_backend(backend)

    ensure_started.assert_called_once_with()
    execute.assert_called_once()
    prepare_command = execute.call_args.args[0]
    assert "codegraph init -i /mnt/material/workspace" in prepare_command
    assert connections == {
        "codegraph": {
            "transport": "stdio",
            "command": "/usr/bin/docker",
            "args": [
                "exec",
                "-i",
                "--workdir",
                "/mnt/material/workspace",
                "test-container",
                "codegraph",
                "serve",
                "--mcp",
                "--no-watch",
                "--path",
                "/mnt/material/workspace",
            ],
        }
    }


def test_prepares_index_and_returns_bwrap_mcp_connection(tmp_path: Path) -> None:
    backend = BwrapSandboxBackend(
        routes=[
            BwrapRoute(
                host_path=tmp_path,
                agent_path="/workspace",
                writable=True,
            )
        ],
        bwrap_bin="/usr/bin/bwrap",
    )
    execute_result = Mock(exit_code=0, output="")

    with patch.object(backend, "execute", return_value=execute_result) as execute:
        connections = codegraph_mcp_connections_for_backend(backend)

    execute.assert_called_once()
    prepare_command = execute.call_args.args[0]
    assert "codegraph init -i /workspace" in prepare_command
    connection = connections["codegraph"]
    assert connection["transport"] == "stdio"
    assert connection["command"] == "/usr/bin/bwrap"
    args = connection["args"]
    assert args[0] != "/usr/bin/bwrap"
    assert "--bind" in args
    assert str(tmp_path.resolve()) in args
    assert "/workspace" in args
    assert args[-3:] == [
        "/bin/sh",
        "-c",
        "exec codegraph serve --mcp --no-watch --path /workspace",
    ]


def test_skips_read_only_bwrap_workspace(tmp_path: Path) -> None:
    backend = BwrapSandboxBackend(
        routes=[
            BwrapRoute(
                host_path=tmp_path,
                agent_path="/workspace",
                writable=False,
            )
        ],
        bwrap_bin="/usr/bin/bwrap",
    )

    with patch(
        "sec_review_agents.mcp.codegraph.log_diagnostic",
    ) as log_diagnostic:
        connections = codegraph_mcp_connections_for_backend(backend)

    assert connections == {}
    log_diagnostic.assert_called_with(
        "codegraph_mcp_skipped",
        reason="index_not_available",
    )


def test_closes_docker_container_when_codegraph_prepare_raises() -> None:
    backend = _docker_backend()

    with (
        patch.object(backend.container, "ensure_started") as ensure_started,
        patch.object(
            backend,
            "execute",
            side_effect=RuntimeError("prepare exploded"),
        ),
        patch.object(backend.container, "close") as close,
        pytest.raises(RuntimeError, match="prepare exploded"),
    ):
        codegraph_mcp_connections_for_backend(backend)

    ensure_started.assert_called_once_with()
    close.assert_called_once_with()


def test_skips_local_backend_without_host_workspace_path(tmp_path: Path) -> None:
    backend = create_backend_with_materials(
        container_name_prefix="test",
        material_views=[
            workspace_view(host_path=tmp_path, writable=True),
        ],
        use_docker_sandbox=False,
    )

    with patch(
        "sec_review_agents.mcp.codegraph.log_diagnostic",
    ) as log_diagnostic:
        connections = codegraph_mcp_connections_for_backend(backend)

    assert connections == {}
    log_diagnostic.assert_called_with(
        "codegraph_mcp_skipped",
        reason="unsupported_backend",
    )


def test_prepares_host_index_and_returns_local_mcp_connection(tmp_path: Path) -> None:
    workspace = tmp_path
    (workspace / ".git" / "info").mkdir(parents=True)
    backend = create_backend_with_materials(
        container_name_prefix="test",
        material_views=[
            workspace_view(host_path=workspace, writable=True),
        ],
        use_docker_sandbox=False,
    )
    completed = subprocess.CompletedProcess(
        args=["codegraph"],
        returncode=0,
        stdout="",
        stderr="",
    )

    with (
        patch(
            "sec_review_agents.mcp.codegraph.shutil.which",
            return_value="/usr/bin/codegraph",
        ),
        patch(
            "sec_review_agents.mcp.codegraph.subprocess.run",
            return_value=completed,
        ) as run,
    ):
        connections = codegraph_mcp_connections_for_backend(
            backend,
            host_workspace_path=workspace,
        )

    run.assert_called_once_with(
        ["codegraph", "init", "-i", str(workspace)],
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert ".codegraph/" in (workspace / ".git" / "info" / "exclude").read_text()
    assert connections == {
        "codegraph": {
            "transport": "stdio",
            "command": "codegraph",
            "args": [
                "serve",
                "--mcp",
                "--no-watch",
                "--path",
                str(workspace),
            ],
        }
    }
