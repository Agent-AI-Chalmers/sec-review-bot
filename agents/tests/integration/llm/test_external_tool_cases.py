import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from tests.integration.llm.external_tool_cases.loader import load_external_tool_cases
from tests.integration.llm.external_tool_cases.runner import (
    assert_external_tool_case_oracles,
    run_external_tool_case,
)
from tests.integration.llm.probe_helpers import ProbeRequirement, llm_probe

_DOCKER_IMAGE_ENV = "AGENT_EXTERNAL_TOOLS_DOCKER_IMAGE"
_DEFAULT_DOCKER_IMAGE = "sec-review-bot-workspace:tools"
_OUTPUT_DIR_ENV = "EXTERNAL_TOOL_CASE_OUTPUT_DIR"
_DEFAULT_OUTPUT_DIR = Path(".agent-artifacts/external-tool-cases")


def _docker_image() -> str:
    return os.environ.get(_DOCKER_IMAGE_ENV) or _DEFAULT_DOCKER_IMAGE


def _case_run_root(case_id: str) -> Path:
    output_root = (
        Path(os.environ.get(_OUTPUT_DIR_ENV) or _DEFAULT_OUTPUT_DIR)
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


CASES = load_external_tool_cases()
PROBE = llm_probe(
    run_env="RUN_LLM_EXTERNAL_TOOL_CASES",
    description="real LLM external CLI discovery cases",
    requires_deployment=False,
    heavy=True,
    requirements=(
        ProbeRequirement(
            name="external tools Docker image",
            is_met=lambda: _docker_image_exists(_docker_image()),
            instruction=(
                "build it with: docker build -f "
                "agents/docker/workspace-tools.Dockerfile -t "
                "sec-review-bot-workspace:tools agents"
            ),
        ),
    ),
)

pytestmark = [PROBE.skip_unless(), pytest.mark.asyncio]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case.id)
async def test_external_tool_discovery_case(case) -> None:
    observation = await run_external_tool_case(
        case,
        run_root=_case_run_root(case.id),
        docker_image=_docker_image(),
    )
    assert_external_tool_case_oracles(case, observation)
    print(observation)
