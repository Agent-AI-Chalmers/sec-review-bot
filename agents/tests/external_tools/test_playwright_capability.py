"""No-model cases proving that the installed Playwright CLI controls Chromium.

These capability cases test deterministic browser behavior in the Docker sandbox.
They do not test whether an agent elects to use Playwright or gathers sufficient
runtime evidence; the LLM discovery mode owns that behavioral contract.
"""

import shlex
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.agents.verification.repository import (
    create_repository_verification_backend,
)
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    BootstrapStatus,
    bootstrap_environment,
)
from tests.external_tools.case_support.loader import (
    cases_for_mode,
    load_external_tool_cases,
)
from tests.external_tools.case_support.models import ExternalToolCase
from tests.external_tools.case_support.runner import (
    materialize_external_tool_case_workspace,
)

_TOOLS_IMAGE = "sec-review-bot-workspace:tools"

pytestmark = pytest.mark.integration
CASES = tuple(
    case
    for case in cases_for_mode(load_external_tool_cases(), "capability")
    if case.tool == "playwright"
)


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


@asynccontextmanager
async def _playwright_backend(case: ExternalToolCase, tmp_path: Path) -> AsyncIterator:
    workspace = tmp_path / "workspace"
    materialize_external_tool_case_workspace(case, workspace)
    assert case.setup_path is not None
    with patch.dict(
        "os.environ",
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_DOCKER_IMAGE": _TOOLS_IMAGE,
            "AGENT_DOCKER_NETWORK_MODE": "none",
            "AGENT_MEMORY_ENABLED": "false",
            "AGENT_SKILLS_ENABLED": "false",
            "AGENT_MCP_ENABLED": "false",
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
            yield backend


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run Playwright capability tests",
)
@pytest.mark.parametrize("case", CASES, ids=lambda case: case.id)
async def test_playwright_capability_case(
    case: ExternalToolCase, tmp_path: Path
) -> None:
    assert case.capability is not None
    assert case.capability.target_url is not None
    session = case.id
    target_url = shlex.quote(case.capability.target_url)
    async with _playwright_backend(case, tmp_path) as backend:
        opened = await backend.aexecute(
            f"playwright cli --browser chromium -s={session} open {target_url}",
            timeout=60,
        )
        assert opened.exit_code == 0, opened.output
        if case.capability.probe == "playwright-browser-state":
            stored = await backend.aexecute(
                f"playwright cli -s={session} eval "
                "\"() => { localStorage.setItem('probe', 'stored'); "
                "return localStorage.getItem('probe'); }\"",
                timeout=30,
            )
            assert stored.exit_code == 0, stored.output
            observed = await backend.aexecute(
                f"playwright cli -s={session} eval "
                "\"() => localStorage.getItem('probe')\"",
                timeout=30,
            )
        else:
            observed = await backend.aexecute(
                f'playwright cli -s={session} eval "() => document.title"',
                timeout=30,
            )
        await backend.aexecute(f"playwright cli -s={session} close", timeout=30)

    assert observed.exit_code == 0, observed.output
    assert case.capability.expected_marker in observed.output
