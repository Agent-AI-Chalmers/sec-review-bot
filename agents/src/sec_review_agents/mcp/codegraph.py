import shlex
import shutil
import subprocess
from contextlib import suppress
from pathlib import Path
from typing import Any

from sec_review_agents.filesystem import docker_runtime
from sec_review_agents.filesystem.bwrap_backend import BwrapSandboxBackend
from sec_review_agents.filesystem.docker_backend import DockerSandboxBackend
from sec_review_agents.observability.diagnostics import log_diagnostic

CODEGRAPH_AGENT_WORKSPACE = "/workspace"


def _prepare_sandbox_codegraph_index(
    backend: BwrapSandboxBackend | DockerSandboxBackend,
    workspace: str,
) -> str | None:
    quoted_workspace = shlex.quote(workspace)
    # CodeGraph CLI reference: https://colbymchenry.github.io/codegraph/reference/cli/
    command = " && ".join(
        [
            "command -v codegraph >/dev/null",
            (
                f"if [ -d {quoted_workspace}/.git/info ]; then "
                f"grep -qxF '.codegraph/' {quoted_workspace}/.git/info/exclude 2>/dev/null "
                f"|| printf '\\n.codegraph/\\n' >> {quoted_workspace}/.git/info/exclude; fi"
            ),
            (
                f"if [ -d {quoted_workspace}/.codegraph ]; then "
                f"codegraph sync {quoted_workspace} || codegraph index -q {quoted_workspace}; "
                f"else codegraph init -i {quoted_workspace}; fi"
            ),
        ]
    )
    result = backend.execute(command, timeout=120)
    if result.exit_code != 0:
        log_diagnostic(
            "codegraph_mcp_prepare_failed",
            exit_code=result.exit_code,
            output=result.output,
        )
        return None
    return workspace


def _add_codegraph_to_git_exclude(workspace: Path) -> None:
    exclude_path = workspace / ".git" / "info" / "exclude"
    if not exclude_path.parent.is_dir():
        return

    current = ""
    if exclude_path.exists():
        current = exclude_path.read_text(encoding="utf-8", errors="ignore")
    if ".codegraph/" not in current.splitlines():
        with exclude_path.open("a", encoding="utf-8") as file_handle:
            file_handle.write("\n.codegraph/\n")


def _run_host_codegraph(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["codegraph", *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _prepare_host_codegraph_index(host_workspace: Path) -> str | None:
    """Ensure the host workspace has a usable CodeGraph index."""
    if shutil.which("codegraph") is None:
        log_diagnostic("codegraph_mcp_skipped", reason="codegraph_not_available")
        return None

    _add_codegraph_to_git_exclude(host_workspace)

    # CodeGraph CLI reference: https://colbymchenry.github.io/codegraph/reference/cli/
    if (host_workspace / ".codegraph").is_dir():
        result = _run_host_codegraph(["sync", str(host_workspace)])
        if result.returncode != 0:
            result = _run_host_codegraph(["index", "-q", str(host_workspace)])
    else:
        result = _run_host_codegraph(["init", "-i", str(host_workspace)])

    if result.returncode != 0:
        log_diagnostic(
            "codegraph_mcp_prepare_failed",
            exit_code=result.returncode,
            output=f"{result.stdout}{result.stderr}",
        )
        return None
    return str(host_workspace)


def codegraph_mcp_connections_for_backend(
    backend: Any,
    *,
    host_workspace_path: Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Build MCP stdio connection config for a backend with a writable workspace."""
    if isinstance(backend, DockerSandboxBackend):
        try:
            backend.container.ensure_started()
            container_workspace = backend.sandbox_path_for_agent_path(
                CODEGRAPH_AGENT_WORKSPACE,
                require_writable=True,
            )
            workspace = (
                None
                if container_workspace is None
                else _prepare_sandbox_codegraph_index(backend, container_workspace)
            )
            if workspace is None:
                log_diagnostic("codegraph_mcp_skipped", reason="index_not_available")
                return {}
            return {
                "codegraph": {
                    "transport": "stdio",
                    "command": docker_runtime.default_docker_bin(),
                    "args": [
                        "exec",
                        "-i",
                        "--workdir",
                        workspace,
                        backend.container_name,
                        "codegraph",
                        "serve",
                        "--mcp",
                        "--no-watch",
                        "--path",
                        workspace,
                    ],
                }
            }
        except Exception:
            with suppress(Exception):
                backend.container.close()
            raise

    if isinstance(backend, BwrapSandboxBackend):
        workspace = backend.sandbox_path_for_agent_path(
            CODEGRAPH_AGENT_WORKSPACE,
            require_writable=True,
        )
        if workspace is None:
            log_diagnostic("codegraph_mcp_skipped", reason="index_not_available")
            return {}
        workspace = _prepare_sandbox_codegraph_index(backend, workspace)
        if workspace is None:
            log_diagnostic("codegraph_mcp_skipped", reason="index_not_available")
            return {}
        command, args = backend.stdio_shell_command(
            "exec codegraph serve --mcp --no-watch --path " f"{shlex.quote(workspace)}"
        )
        return {
            "codegraph": {
                "transport": "stdio",
                "command": command,
                "args": args,
            }
        }

    if host_workspace_path is None:
        log_diagnostic("codegraph_mcp_skipped", reason="unsupported_backend")
        return {}

    workspace = _prepare_host_codegraph_index(host_workspace_path)
    if workspace is None:
        return {}
    return {
        "codegraph": {
            "transport": "stdio",
            "command": "codegraph",
            "args": [
                "serve",
                "--mcp",
                "--no-watch",
                "--path",
                workspace,
            ],
        }
    }
