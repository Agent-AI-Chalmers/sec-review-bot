"""No-model cases proving that the installed Joern CLI can provide CPG evidence.

These capability cases test the tool and sandbox integration directly. They do not
test whether an agent discovers Joern or chooses an effective query; the LLM
discovery and comparison modes own those behavioral questions.
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
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from tests.external_tools.case_support.loader import (
    cases_for_mode,
    load_external_tool_cases,
)
from tests.external_tools.case_support.models import ExternalToolCase
from tests.external_tools.case_support.runner import (
    materialize_external_tool_case_workspace,
)

_TOOLS_IMAGE = "sec-review-bot-workspace:tools"
_QUERIES = {
    "joern-cross-file-call": (
        'println("CALLS=" + ' 'cpg.method.name("authorize").call.name.l.mkString(","))'
    ),
    "joern-source-to-sink": (
        'println("FLOW_COUNT=" + cpg.call.name("system").argument.reachableByFlows('
        'cpg.call.name("read_input")).p.l.size)'
    ),
}

pytestmark = pytest.mark.integration
CASES = tuple(
    case
    for case in cases_for_mode(load_external_tool_cases(), "capability")
    if case.tool == "joern"
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


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _tools_image_available(),
    reason="build sec-review-bot-workspace:tools to run Joern capability tests",
)
@pytest.mark.parametrize("case", CASES, ids=lambda case: case.id)
async def test_joern_capability_case(case: ExternalToolCase, tmp_path: Path) -> None:
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
            parse = await backend.aexecute(
                "cd /workspace && joern-parse --language c . "
                "-o /tmp/external-tools-cpg.bin",
                timeout=120,
            )
            assert parse.exit_code == 0, parse.output
            query = _QUERIES[case.capability.probe]
            result = await backend.aexecute(
                "cd /tmp && printf '%s\\n' "
                "'importCpg(\"/tmp/external-tools-cpg.bin\")' "
                f"'{query}' | joern",
                timeout=120,
            )

    assert result.exit_code == 0, result.output
    assert case.capability.expected_marker in result.output
