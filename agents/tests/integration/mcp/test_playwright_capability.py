"""No-model capability test for Playwright MCP in the Docker sandbox.

Unlike the resolver contract tests, this starts the real Docker backend, setup
service, MCP server, and Chromium. Navigation and evaluation are separate tool
calls so the assertion proves that one managed MCP session preserves browser
state across calls without relying on model behavior.
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

from sec_review_agents.agents.verification.repository import (
    create_repository_verification_backend,
)
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.mcp.client import managed_mcp_tools_async
from sec_review_agents.mcp.playwright import playwright_mcp_connections_for_backend
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    BootstrapStatus,
    bootstrap_environment,
)
from tests.integration.llm.mcp_cases.loader import load_mcp_cases

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


def _tool(tools: list[BaseTool], name: str) -> BaseTool:
    return next(tool for tool in tools if tool.name == name)


@asynccontextmanager
async def _playwright_tools(tmp_path: Path) -> AsyncIterator[list[Any]]:
    case = next(
        case for case in load_mcp_cases() if case.id == "playwright-reflected-xss"
    )
    workspace = tmp_path / "workspace"
    shutil.copytree(case.workspace_source, workspace)

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
        backend = create_repository_verification_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
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
    reason="build sec-review-bot-workspace:tools to run Playwright capability tests",
)
async def test_playwright_preserves_browser_state_in_verifier_sandbox(
    tmp_path: Path,
) -> None:
    async with _playwright_tools(tmp_path) as tools:
        navigate = _tool(tools, "playwright_browser_navigate")
        evaluate = _tool(tools, "playwright_browser_evaluate")
        close = _tool(tools, "playwright_browser_close")

        await navigate.ainvoke(
            {
                "url": (
                    "http://127.0.0.1:8765/"
                    "?q=%3Cscript%3Edocument.title%3D"
                    "%27CAPABILITY_OK%27%3C%2Fscript%3E"
                )
            }
        )
        evaluation = await evaluate.ainvoke({"function": "() => document.title"})
        await close.ainvoke({})

    assert "CAPABILITY_OK" in str(evaluation)


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run Playwright capability tests",
)
async def test_playwright_preserves_storage_across_navigation(tmp_path: Path) -> None:
    async with _playwright_tools(tmp_path) as tools:
        navigate = _tool(tools, "playwright_browser_navigate")
        evaluate = _tool(tools, "playwright_browser_evaluate")
        close = _tool(tools, "playwright_browser_close")

        await navigate.ainvoke({"url": "http://127.0.0.1:8765/first"})
        await evaluate.ainvoke(
            {"function": "() => localStorage.setItem('probe', 'stored')"}
        )
        await navigate.ainvoke({"url": "http://127.0.0.1:8765/second"})
        evaluation = await evaluate.ainvoke(
            {"function": "() => localStorage.getItem('probe')"}
        )
        await close.ainvoke({})

    assert "stored" in str(evaluation)
