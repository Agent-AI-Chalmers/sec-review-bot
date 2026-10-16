"""No-model capability test for CodeGraph MCP in the Docker sandbox.

The resolver contract tests mock index preparation and connection construction.
This test builds a real workspace index, starts the real MCP server through the
Docker resolver, and verifies that its explore tool returns a cross-file caller
relationship without relying on model behavior.
"""

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.agents.analysis.repository import (
    create_repository_analyzer_backend,
)
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.mcp.client import managed_mcp_tools_async
from sec_review_agents.mcp.codegraph import codegraph_mcp_connections_for_backend
from sec_review_agents.runtime.backend_cleanup import amanaged_backend

_TOOLS_IMAGE = "sec-review-bot-workspace:tools"


def _tools_image_available() -> bool:
    if not is_docker_runtime_available(default_docker_bin()):
        return False
    result = subprocess.run(
        [default_docker_bin(), "image", "inspect", _TOOLS_IMAGE],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.returncode == 0


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run CodeGraph capability tests",
)
async def test_codegraph_explores_cross_file_call_relationship(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "service.py").write_text(
        "def validate_token(token: str) -> bool:\n    return token == 'trusted'\n",
        encoding="utf-8",
    )
    (workspace / "handler.py").write_text(
        "from service import validate_token\n\n"
        "def authorize(request):\n"
        "    return validate_token(request.token)\n",
        encoding="utf-8",
    )

    with patch.dict(
        "os.environ",
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_DOCKER_IMAGE": _TOOLS_IMAGE,
            "AGENT_DOCKER_NETWORK_MODE": "none",
            "AGENT_MEMORY_ENABLED": "false",
            "AGENT_SKILLS_ENABLED": "false",
        },
        clear=False,
    ):
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )
        async with amanaged_backend(backend):
            connections = codegraph_mcp_connections_for_backend(backend)
            async with managed_mcp_tools_async(connections) as tools:
                explore = next(
                    tool for tool in tools if tool.name == "codegraph_codegraph_explore"
                )
                result = await explore.ainvoke(
                    {"query": "validate_token authorize caller relationship"}
                )

    result_text = str(result)
    assert "validate_token" in result_text
    assert "authorize" in result_text
