import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from tests.integration.llm.mcp_cases.loader import cases_for_mode, load_mcp_cases
from tests.integration.llm.mcp_cases.runner import (
    assert_mcp_case_oracles,
    run_mcp_case,
)
from tests.integration.llm.probe_helpers import ProbeRequirement, llm_probe

_MCP_DOCKER_IMAGE_ENV = "AGENT_MCP_DOCKER_IMAGE"
_DEFAULT_MCP_DOCKER_IMAGE = "sec-review-bot-workspace:tools"
_MCP_CASE_OUTPUT_DIR_ENV = "MCP_CASE_OUTPUT_DIR"
_DEFAULT_MCP_CASE_OUTPUT_DIR = Path(".agent-artifacts/mcp-cases")


def _mcp_docker_image() -> str:
    return os.environ.get(_MCP_DOCKER_IMAGE_ENV) or _DEFAULT_MCP_DOCKER_IMAGE


def _case_run_root(case_id: str) -> Path:
    output_root = (
        Path(os.environ.get(_MCP_CASE_OUTPUT_DIR_ENV) or _DEFAULT_MCP_CASE_OUTPUT_DIR)
        .expanduser()
        .resolve()
    )
    return output_root / f"{case_id}-{uuid4().hex[:8]}"


def _docker_image_exists(image: str) -> bool:
    if not is_docker_runtime_available(default_docker_bin()):
        return False
    result = subprocess.run(
        [default_docker_bin(), "image", "inspect", image],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.returncode == 0


CASES = load_mcp_cases()
PROBE = llm_probe(
    run_env="RUN_LLM_MCP_CASES",
    description="real LLM end-to-end MCP cases",
    requires_deployment=False,
    heavy=True,
    requirements=(
        ProbeRequirement(
            name="MCP tools Docker image",
            is_met=lambda: _docker_image_exists(_mcp_docker_image()),
            instruction=(
                "build it with: docker build -f "
                "agents/docker/workspace-tools.Dockerfile -t "
                "sec-review-bot-workspace:tools agents"
            ),
        ),
    ),
)

pytestmark = [PROBE.skip_unless(), pytest.mark.asyncio]


@pytest.mark.parametrize(
    "case",
    cases_for_mode(CASES, "discovery"),
    ids=lambda case: case.id,
)
async def test_mcp_discovery_case(case) -> None:
    observation = await run_mcp_case(
        case,
        run_root=_case_run_root(case.id),
        docker_image=_mcp_docker_image(),
        mcp_enabled=True,
    )
    assert_mcp_case_oracles(case, observation)
    print(observation)


@pytest.mark.parametrize(
    "case",
    cases_for_mode(CASES, "compare"),
    ids=lambda case: case.id,
)
async def test_mcp_comparison_case(case) -> None:
    run_root = _case_run_root(case.id)
    without_mcp = await run_mcp_case(
        case,
        run_root=run_root / "without-mcp",
        docker_image=_mcp_docker_image(),
        mcp_enabled=False,
    )
    with_mcp = await run_mcp_case(
        case,
        run_root=run_root / "with-mcp",
        docker_image=_mcp_docker_image(),
        mcp_enabled=True,
    )
    for prefix in case.oracles.without_mcp_forbidden_tool_prefixes:
        assert not any(name.startswith(prefix) for name in without_mcp["toolNames"])
    assert (
        without_mcp["result"]["validation_level"]
        not in case.oracles.without_mcp_forbidden_validation_levels
    ), without_mcp["result"]
    assert_mcp_case_oracles(case, with_mcp)
    print({"withoutMcp": without_mcp, "withMcp": with_mcp})
