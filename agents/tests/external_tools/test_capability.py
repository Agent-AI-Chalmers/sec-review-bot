"""No-model cases proving that external CLIs work in the Docker sandbox.

Capability cases test deterministic tool behavior and integration. LLM discovery
and comparison tests own agent tool-selection and evidence-gathering behavior.
"""

import shlex
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.agents.analysis.repository import (
    create_repository_analyzer_backend,
)
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
from tests.external_tools.cases.loader import (
    cases_for_mode,
    load_external_tool_cases,
)
from tests.external_tools.cases.models import ExternalToolCase
from tests.external_tools.cases.runner import (
    materialize_external_tool_case_workspace,
)

_TOOLS_IMAGE = "sec-review-bot-workspace:tools"
_JOERN_QUERIES = {
    "joern-cross-file-call": (
        'println("CALLS=" + ' 'cpg.method.name("authorize").call.name.l.mkString(","))'
    ),
    "joern-source-to-sink": (
        'println("FLOW_COUNT=" + cpg.call.name("system").argument.reachableByFlows('
        'cpg.call.name("read_input")).p.l.size)'
    ),
}

pytestmark = pytest.mark.integration
CASES = cases_for_mode(load_external_tool_cases(), "capability")
JOERN_CASES = tuple(case for case in CASES if case.tool == "joern")
PLAYWRIGHT_CASES = tuple(case for case in CASES if case.tool == "playwright")


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
    reason="build sec-review-bot-workspace:tools to run capability tests",
)
@pytest.mark.parametrize("case", JOERN_CASES, ids=lambda case: case.id)
async def test_joern_capability(case: ExternalToolCase, tmp_path: Path) -> None:
    assert case.capability is not None
    workspace = tmp_path / "workspace"
    materialize_external_tool_case_workspace(case, workspace)
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
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )
        async with amanaged_backend(backend):
            parsed = await backend.aexecute(
                "cd /workspace && joern-parse --language c . "
                "-o /tmp/external-tools-cpg.bin",
                timeout=120,
            )
            assert parsed.exit_code == 0, parsed.output
            query = _JOERN_QUERIES[case.capability.probe]
            result = await backend.aexecute(
                "cd /tmp && printf '%s\\n' "
                "'importCpg(\"/tmp/external-tools-cpg.bin\")' "
                f"'{query}' | joern",
                timeout=120,
            )

    assert result.exit_code == 0, result.output
    assert case.capability.expected_marker in result.output


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run capability tests",
)
@pytest.mark.parametrize("case", PLAYWRIGHT_CASES, ids=lambda case: case.id)
async def test_playwright_capability(case: ExternalToolCase, tmp_path: Path) -> None:
    assert case.capability is not None
    assert case.capability.target_url is not None
    session = case.id
    async with _playwright_backend(case, tmp_path) as backend:
        opened = await backend.aexecute(
            "playwright cli --browser chromium "
            f"-s={session} open {shlex.quote(case.capability.target_url)}",
            timeout=60,
        )
        assert opened.exit_code == 0, opened.output
        observed = await backend.aexecute(
            f'playwright cli -s={session} eval "() => document.title"',
            timeout=30,
        )
        await backend.aexecute(f"playwright cli -s={session} close", timeout=30)

    assert observed.exit_code == 0, observed.output
    assert case.capability.expected_marker in observed.output
