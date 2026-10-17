import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from tests.external_tools.cases.loader import (
    cases_for_mode,
    load_external_tool_cases,
)
from tests.external_tools.cases.runner import (
    assert_external_tool_case_oracles,
    has_required_external_tool_evidence,
    materialize_external_tool_case_workspace,
    run_external_tool_case,
    write_external_tool_comparison_summary,
)
from tests.llm.probe_helpers import ProbeRequirement, llm_probe

_DOCKER_IMAGE_ENV = "AGENT_EXTERNAL_TOOLS_DOCKER_IMAGE"
_DEFAULT_DOCKER_IMAGE = "sec-review-bot-workspace:tools"
_BASELINE_DOCKER_IMAGE_ENV = "AGENT_EXTERNAL_TOOLS_BASELINE_DOCKER_IMAGE"
_DEFAULT_BASELINE_DOCKER_IMAGE = "mcr.microsoft.com/devcontainers/universal:6-noble"
_OUTPUT_DIR_ENV = "EXTERNAL_TOOL_CASE_OUTPUT_DIR"
_DEFAULT_OUTPUT_DIR = Path(".agent-artifacts/external-tool-cases")


def _docker_image() -> str:
    return os.environ.get(_DOCKER_IMAGE_ENV) or _DEFAULT_DOCKER_IMAGE


def _baseline_docker_image() -> str:
    return os.environ.get(_BASELINE_DOCKER_IMAGE_ENV) or _DEFAULT_BASELINE_DOCKER_IMAGE


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
        ProbeRequirement(
            name="baseline Docker image without external tools",
            is_met=lambda: _docker_image_exists(_baseline_docker_image()),
            instruction=(
                "pull or build the base image: "
                "mcr.microsoft.com/devcontainers/universal:6-noble"
            ),
        ),
    ),
)

pytestmark = [
    PROBE.skip_unless(),
    pytest.mark.asyncio,
    pytest.mark.integration,
    pytest.mark.llm,
]


@pytest.mark.parametrize(
    "case", cases_for_mode(CASES, "discovery"), ids=lambda case: case.id
)
async def test_external_tool_discovery_case(case) -> None:
    observation = await run_external_tool_case(
        case,
        mode="discovery",
        run_root=_case_run_root(case.id),
        docker_image=_docker_image(),
    )
    assert_external_tool_case_oracles(case, observation)
    print(observation)


@pytest.mark.parametrize(
    "case", cases_for_mode(CASES, "compare"), ids=lambda case: case.id
)
async def test_external_tool_comparison_case(case) -> None:
    run_root = _case_run_root(case.id)
    source_workspace = run_root / "source-workspace"
    materialize_external_tool_case_workspace(case, source_workspace)
    without_tool = await run_external_tool_case(
        case,
        mode="compare",
        run_root=run_root / "without-tool",
        docker_image=_baseline_docker_image(),
        external_tool_enabled=False,
        workspace_source=source_workspace,
    )
    with_tool = await run_external_tool_case(
        case,
        mode="compare",
        run_root=run_root / "with-tool",
        docker_image=_docker_image(),
        external_tool_enabled=True,
        workspace_source=source_workspace,
    )

    summary_path = run_root / "comparison-summary.json"
    write_external_tool_comparison_summary(
        summary_path,
        case=case,
        without_tool=without_tool,
        with_tool=with_tool,
    )
    assert not has_required_external_tool_evidence(case, without_tool)
    assert has_required_external_tool_evidence(case, with_tool)
    print(summary_path.read_text(encoding="utf-8"))
