"""No-model cases proving real MCP servers work in the Docker sandbox.

Contract tests mock connection construction. These capability cases exercise the
real backend, MCP server, and tool behavior without involving model decisions.
"""

import shutil
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from langchain_core.tools import BaseTool

from sec_review_agents.agents.analysis.repository import (
    build_repository_analyzer_backend_config,
)
from sec_review_agents.agents.verification.repository import (
    build_repository_verification_backend_config,
)
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.mcp.client import managed_mcp_tools_async
from sec_review_agents.mcp.codegraph import codegraph_mcp_connections_for_backend
from sec_review_agents.mcp.playwright import playwright_mcp_connections_for_backend
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    BootstrapStatus,
    bootstrap_environment,
)
from tests.mcp.cases.loader import cases_for_mode, load_mcp_cases
from tests.mcp.cases.models import McpCase

_TOOLS_IMAGE = "sec-review-bot-workspace:tools"

pytestmark = pytest.mark.integration
CASES = cases_for_mode(load_mcp_cases(), "capability")
CODEGRAPH_CASES = tuple(case for case in CASES if case.mcp == "codegraph")
PLAYWRIGHT_CASES = tuple(case for case in CASES if case.mcp == "playwright")


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


def _tool(tools: list[BaseTool], name: str) -> BaseTool:
    return next(tool for tool in tools if tool.name == name)


@asynccontextmanager
async def _playwright_tools(case: McpCase, tmp_path: Path) -> AsyncIterator[list[Any]]:
    workspace = tmp_path / "workspace"
    shutil.copytree(case.workspace_source, workspace)
    assert case.setup_path is not None

    with patch.dict(
        "os.environ",
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_DOCKER_IMAGE": _TOOLS_IMAGE,
            "AGENT_DOCKER_NETWORK_MODE": "none",
            "AGENT_MEMORY_CONSUMPTION_ENABLED": "false",
            "AGENT_SKILLS_ENABLED": "false",
        },
        clear=False,
    ):
        backend = create_backend_with_path_views(
            **build_repository_verification_backend_config(
                workspace_root_path=workspace,
                history_path=None,
                incremental_window_path=None,
                scan_mode="full",
            )
        )
        async with amanaged_backend(backend):
            bootstrap = await bootstrap_environment(
                backend,
                setup_declaration_content=case.setup_path.read_text(encoding="utf-8"),
            )
            assert bootstrap.status is BootstrapStatus.COMPLETED
            connections = playwright_mcp_connections_for_backend(backend)
            async with managed_mcp_tools_async(connections) as tools:
                yield tools


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run MCP capability tests",
)
@pytest.mark.parametrize("case", CODEGRAPH_CASES, ids=lambda case: case.id)
async def test_codegraph_capability(case: McpCase, tmp_path: Path) -> None:
    assert case.capability is not None
    workspace = tmp_path / "workspace"
    shutil.copytree(case.workspace_source, workspace)
    with patch.dict(
        "os.environ",
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_DOCKER_IMAGE": _TOOLS_IMAGE,
            "AGENT_DOCKER_NETWORK_MODE": "none",
            "AGENT_MEMORY_CONSUMPTION_ENABLED": "false",
            "AGENT_SKILLS_ENABLED": "false",
        },
        clear=False,
    ):
        backend = create_backend_with_path_views(
            **build_repository_analyzer_backend_config(
                workspace_root_path=workspace,
                history_path=None,
                incremental_window_path=None,
                scan_mode="full",
            )
        )
        async with amanaged_backend(backend):
            connections = codegraph_mcp_connections_for_backend(backend)
            async with managed_mcp_tools_async(connections) as tools:
                explore = _tool(tools, "codegraph_codegraph_explore")
                result = await explore.ainvoke(
                    {"query": "validate_token authorize caller relationship"}
                )

    result_text = str(result)
    assert case.capability.expected_marker in result_text
    assert "authorize" in result_text


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run MCP capability tests",
)
@pytest.mark.parametrize("case", PLAYWRIGHT_CASES, ids=lambda case: case.id)
async def test_playwright_capability(case: McpCase, tmp_path: Path) -> None:
    assert case.capability is not None
    assert case.capability.target_url is not None
    async with _playwright_tools(case, tmp_path) as tools:
        navigate = _tool(tools, "playwright_browser_navigate")
        evaluate = _tool(tools, "playwright_browser_evaluate")
        close = _tool(tools, "playwright_browser_close")

        await navigate.ainvoke({"url": case.capability.target_url})
        evaluation = await evaluate.ainvoke({"function": "() => document.title"})
        await close.ainvoke({})

    assert case.capability.expected_marker in str(evaluation)
