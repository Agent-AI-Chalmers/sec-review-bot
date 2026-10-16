import shlex
from contextlib import suppress
from typing import Any

from sec_review_agents.filesystem import docker_runtime
from sec_review_agents.filesystem.docker_backend import DockerSandboxBackend
from sec_review_agents.observability.diagnostics import log_diagnostic

PLAYWRIGHT_AGENT_WORKSPACE = "/workspace"
PLAYWRIGHT_BROWSER_ROOT = "/ms-playwright"
PLAYWRIGHT_OUTPUT_DIR = "/tmp/sec-review-playwright-mcp"


def _docker_playwright_executable(backend: DockerSandboxBackend) -> str | None:
    command = " && ".join(
        [
            "command -v playwright-mcp >/dev/null",
            (
                f"find {shlex.quote(PLAYWRIGHT_BROWSER_ROOT)} -type f -name chrome "
                "-path '*/chrome-linux*/chrome' -print -quit"
            ),
        ]
    )
    result = backend.execute(command, timeout=30)
    if result.exit_code != 0:
        return None
    executable = result.output.strip().splitlines()
    return executable[-1] if executable else None


def playwright_mcp_connections_for_backend(
    backend: Any,
) -> dict[str, dict[str, Any]]:
    # Playwright is intentionally Docker-only. The browser and MCP server must
    # share the stage's long-lived sandbox with services started during setup.
    # Bwrap creates a fresh, short-lived PID/network namespace for each command,
    # so a setup service cannot survive into the later MCP invocation. This is
    # different from CodeGraph, whose index persists through the mounted
    # workspace and can be reopened by a separate bwrap invocation.
    if not isinstance(backend, DockerSandboxBackend):
        log_diagnostic("playwright_mcp_skipped", reason="unsupported_backend")
        return {}

    try:
        backend.container.ensure_started()
        workspace = backend.sandbox_path_for_agent_path(
            PLAYWRIGHT_AGENT_WORKSPACE,
            require_writable=True,
        )
        executable = _docker_playwright_executable(backend)
        if workspace is None or executable is None:
            log_diagnostic("playwright_mcp_skipped", reason="runtime_not_available")
            return {}

        launch_command = " ".join(
            [
                "exec playwright-mcp",
                "--headless",
                "--isolated",
                "--no-sandbox",
                "--browser chrome",
                f"--executable-path {shlex.quote(executable)}",
                "--block-service-workers",
                "--image-responses omit",
                f"--output-dir {shlex.quote(PLAYWRIGHT_OUTPUT_DIR)}",
                "--snapshot-mode full",
                "--no-webmcp",
            ]
        )
        return {
            "playwright": {
                "transport": "stdio",
                "command": docker_runtime.default_docker_bin(),
                "args": [
                    "exec",
                    "-i",
                    "--workdir",
                    workspace,
                    backend.container_name,
                    "/bin/sh",
                    "-lc",
                    launch_command,
                ],
            }
        }
    except Exception:
        with suppress(Exception):
            backend.close()
        raise
