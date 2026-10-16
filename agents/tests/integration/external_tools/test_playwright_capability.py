"""No-model capability tests for Playwright CLI in the Docker sandbox."""

import shutil
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

_TOOLS_IMAGE = "sec-review-bot-workspace:tools"
_FIXTURE = Path(__file__).with_name("fixtures") / "playwright"


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
async def _playwright_backend(tmp_path: Path) -> AsyncIterator:
    workspace = tmp_path / "workspace"
    shutil.copytree(_FIXTURE, workspace)
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
                setup_declaration_content=(_FIXTURE / "setup.yml").read_text(
                    encoding="utf-8"
                ),
            )
            assert bootstrap.status is BootstrapStatus.COMPLETED
            yield backend


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run Playwright capability tests",
)
async def test_playwright_cli_preserves_browser_state(tmp_path: Path) -> None:
    async with _playwright_backend(tmp_path) as backend:
        opened = await backend.aexecute(
            "playwright cli --browser chromium -s=capability "
            "open http://127.0.0.1:8770/",
            timeout=60,
        )
        assert opened.exit_code == 0, opened.output
        stored = await backend.aexecute(
            "playwright cli -s=capability eval "
            "\"() => { localStorage.setItem('probe', 'stored'); "
            "return localStorage.getItem('probe'); }\"",
            timeout=30,
        )
        assert stored.exit_code == 0, stored.output
        read_back = await backend.aexecute(
            "playwright cli -s=capability eval "
            "\"() => localStorage.getItem('probe')\"",
            timeout=30,
        )
        await backend.aexecute("playwright cli -s=capability close", timeout=30)

    assert read_back.exit_code == 0, read_back.output
    assert "stored" in read_back.output


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run Playwright capability tests",
)
async def test_playwright_cli_observes_browser_sink_effect(tmp_path: Path) -> None:
    url = (
        "http://127.0.0.1:8770/"
        "?q=%3Cscript%3Edocument.title%3D"
        "%27PLAYWRIGHT_CLI_EXECUTED%27%3C%2Fscript%3E"
    )
    async with _playwright_backend(tmp_path) as backend:
        opened = await backend.aexecute(
            f"playwright cli --browser chromium -s=sink open '{url}'",
            timeout=60,
        )
        assert opened.exit_code == 0, opened.output
        observed = await backend.aexecute(
            'playwright cli -s=sink eval "() => document.title"',
            timeout=30,
        )
        await backend.aexecute("playwright cli -s=sink close", timeout=30)

    assert observed.exit_code == 0, observed.output
    assert "PLAYWRIGHT_CLI_EXECUTED" in observed.output
