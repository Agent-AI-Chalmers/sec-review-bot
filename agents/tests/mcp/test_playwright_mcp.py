"""Contract tests for the Playwright MCP resolver.

These tests isolate connection construction, backend gating, and launch policy
with mocks. They do not start an MCP server or prove that browser state survives
multiple tool calls; the real capability check lives in test_capability.py.
"""

from unittest.mock import Mock, patch

import pytest

from sec_review_agents.filesystem.docker_backend import (
    DockerRoute,
    DockerSandboxBackend,
)
from sec_review_agents.filesystem.docker_runtime import DockerContainerResource
from sec_review_agents.mcp.playwright import playwright_mcp_connections_for_backend


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


def test_returns_docker_exec_connection_for_workspace_browser() -> None:
    backend = _docker_backend()
    execute_result = Mock(
        exit_code=0,
        output="/ms-playwright/chromium-123/chrome-linux/chrome\n",
    )

    with (
        patch.object(backend.container, "ensure_started") as ensure_started,
        patch.object(backend, "execute", return_value=execute_result) as execute,
        patch(
            "sec_review_agents.filesystem.docker_runtime.default_docker_bin",
            return_value="/usr/bin/docker",
        ),
    ):
        connections = playwright_mcp_connections_for_backend(backend)

    ensure_started.assert_called_once_with()
    execute.assert_called_once()
    connection = connections["playwright"]
    assert connection["command"] == "/usr/bin/docker"
    assert connection["args"][:5] == [
        "exec",
        "-i",
        "--workdir",
        "/mnt/material/workspace",
        "test-container",
    ]
    launch_command = connection["args"][-1]
    assert "exec playwright-mcp" in launch_command
    assert "--headless" in launch_command
    assert "--no-sandbox" in launch_command
    assert "--image-responses omit" in launch_command
    assert "--executable-path /ms-playwright/chromium-123/chrome-linux/chrome" in (
        launch_command
    )


def test_skips_docker_backend_without_browser_runtime() -> None:
    backend = _docker_backend()

    with (
        patch.object(backend.container, "ensure_started"),
        patch.object(
            backend,
            "execute",
            return_value=Mock(exit_code=1, output=""),
        ),
        patch(
            "sec_review_agents.mcp.playwright.log_diagnostic",
        ) as log_diagnostic,
    ):
        connections = playwright_mcp_connections_for_backend(backend)

    assert connections == {}
    log_diagnostic.assert_called_with(
        "playwright_mcp_skipped",
        reason="runtime_not_available",
    )


def test_skips_non_docker_backend() -> None:
    with patch(
        "sec_review_agents.mcp.playwright.log_diagnostic",
    ) as log_diagnostic:
        connections = playwright_mcp_connections_for_backend(object())

    assert connections == {}
    log_diagnostic.assert_called_with(
        "playwright_mcp_skipped",
        reason="unsupported_backend",
    )


def test_resolver_does_not_close_borrowed_backend_on_failure() -> None:
    backend = _docker_backend()

    with (
        patch.object(
            backend.container,
            "ensure_started",
            side_effect=RuntimeError("start failed"),
        ),
        patch.object(backend, "close") as close,
        pytest.raises(RuntimeError, match="start failed"),
    ):
        playwright_mcp_connections_for_backend(backend)

    close.assert_not_called()
