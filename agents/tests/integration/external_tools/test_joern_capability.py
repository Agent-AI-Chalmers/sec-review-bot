"""No-model capability tests for Joern CLI in the Docker sandbox."""

import shutil
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
from sec_review_agents.runtime.backend_cleanup import amanaged_backend

_TOOLS_IMAGE = "sec-review-bot-workspace:tools"
_FIXTURE = Path(__file__).with_name("fixtures") / "joern"


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


async def _query_joern(tmp_path: Path, query: str) -> str:
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
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )
        async with amanaged_backend(backend):
            parse = await backend.aexecute(
                "cd /workspace && joern-parse --language c . "
                "-o /tmp/external-tools-cpg.bin",
                timeout=120,
            )
            assert parse.exit_code == 0, parse.output
            command = (
                "cd /tmp && printf '%s\\n' "
                "'importCpg(\"/tmp/external-tools-cpg.bin\")' "
                f"'{query}' | joern"
            )
            result = await backend.aexecute(command, timeout=120)
            assert result.exit_code == 0, result.output
            return result.output


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run Joern capability tests",
)
async def test_joern_queries_cross_file_calls(tmp_path: Path) -> None:
    output = await _query_joern(
        tmp_path,
        'println("CALLS=" + cpg.method.name("authorize").call.name.l.mkString(","))',
    )

    assert "CALLS=validate_token" in output


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run Joern capability tests",
)
async def test_joern_queries_source_to_sink_data_flow(tmp_path: Path) -> None:
    output = await _query_joern(
        tmp_path,
        'println("FLOW_COUNT=" + cpg.call.name("system").argument.reachableByFlows('
        'cpg.call.name("read_input")).p.l.size)',
    )

    assert "FLOW_COUNT=1" in output
