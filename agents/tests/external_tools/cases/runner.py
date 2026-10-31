import json
import re
import shutil
import subprocess
from collections import Counter
from pathlib import Path
from time import monotonic
from unittest.mock import patch

from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.utils.files import write_json
from sec_review_agents.workflows.repository_case.analysis import analyze_repository_case
from sec_review_agents.workflows.repository_case.verification import (
    verify_repository_case,
)
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.analysis_fixtures import analysis_fixture
from tests.external_tools.cases.models import (
    ExternalToolCase,
    ExternalToolCaseMode,
    ExternalToolInteractionOracle,
)
from tests.runtime.trajectory_artifact_helpers import (
    tool_interactions_from_trajectory,
    tool_usage_from_trajectory,
)


async def run_external_tool_case(
    case: ExternalToolCase,
    *,
    mode: ExternalToolCaseMode,
    run_root: Path,
    docker_image: str,
    external_tool_enabled: bool = True,
    workspace_source: Path | None = None,
) -> dict:
    if mode == "capability":
        raise ValueError("capability cases use the deterministic capability runner")
    agent_case = case.agent_case_for(mode)
    run_root.mkdir(parents=True, exist_ok=False)
    workspace = run_root / "workspace"
    snapshot = run_root / "workspace.snapshot.tar"
    artifact_role = "analyzer" if agent_case.workflow == "analysis" else "verifier"
    artifacts = run_root / "artifacts" / artifact_role
    if workspace_source is None:
        materialize_external_tool_case_workspace(case, workspace)
    else:
        shutil.copytree(workspace_source, workspace, symlinks=True)
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=snapshot)
    setup_content = (
        case.setup_path.read_text(encoding="utf-8")
        if case.setup_path is not None
        else None
    )

    started_at = monotonic()
    with patch.dict(
        "os.environ",
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_DOCKER_IMAGE": docker_image,
            "AGENT_DOCKER_NETWORK_MODE": "none",
            "AGENT_JOERN_ENABLED": str(external_tool_enabled and case.tool == "joern"),
            "AGENT_PLAYWRIGHT_ENABLED": str(
                external_tool_enabled and case.tool == "playwright"
            ),
            "AGENT_MCP_ENABLED": "false",
            "AGENT_MEMORY_CONSUMPTION_ENABLED": "false",
            "AGENT_SKILLS_ENABLED": "false",
        },
        clear=False,
    ):
        if agent_case.workflow == "analysis":
            analysis = await analyze_repository_case(
                workspace_snapshot_tar_path=snapshot,
                history_path=None,
                incremental_window_path=None,
                analyzer_artifacts_path=artifacts,
                scan_mode="full",
                review_input=agent_case.review_input,
            )
            result = analysis.model_dump(mode="json", by_alias=True)
            trajectory = artifacts / "trajectory.jsonl"
        else:
            verification = await verify_repository_case(
                workspace_snapshot_tar_path=snapshot,
                history_path=None,
                incremental_window_path=None,
                verifier_artifacts_path=artifacts,
                scan_mode="full",
                review_input=agent_case.review_input,
                analysis_result=analysis_fixture(
                    overview=agent_case.analysis_overview,
                    verdict="confirmed-vulnerability",
                    narratives=[],
                ),
                mitigation_result=MitigationStageResult(
                    overview="No mitigation patch was supplied.", patch_diff=""
                ),
                setup_declaration_content=setup_content,
            )
            result = verification.model_dump(mode="json")
            trajectory = artifacts / "trajectories" / "initial.jsonl"
    duration_seconds = monotonic() - started_at

    usage = tool_usage_from_trajectory(trajectory)
    return {
        "case": case.id,
        "mode": mode,
        "tool": case.tool,
        "externalToolEnabled": external_tool_enabled,
        "dockerImage": docker_image,
        "durationSeconds": duration_seconds,
        "artifactRoot": str(run_root),
        "toolNames": usage["toolNames"],
        "toolErrors": usage["toolErrors"],
        "toolInteractions": tool_interactions_from_trajectory(trajectory),
        "result": result,
    }


def materialize_external_tool_case_workspace(
    case: ExternalToolCase, destination: Path
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if case.checkout is None:
        shutil.copytree(case.workspace_source, destination, symlinks=True)
        return
    destination.mkdir()
    subprocess.run(
        ["git", "init", "--quiet"],
        cwd=destination,
        check=True,
        capture_output=True,
        text=True,
    )
    fetch_command = [
        "git",
        "fetch",
        "--quiet",
        "--depth",
        "1",
        case.checkout.repository,
        case.checkout.commit,
    ]
    for attempt in range(2):
        fetch = subprocess.run(
            fetch_command,
            cwd=destination,
            check=False,
            capture_output=True,
            text=True,
        )
        if fetch.returncode == 0:
            break
        if attempt == 1:
            raise RuntimeError(
                "failed to fetch pinned external-tool checkout "
                f"{case.checkout.repository}@{case.checkout.commit}: "
                f"{fetch.stderr.strip()}"
            )
    subprocess.run(
        ["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
        cwd=destination,
        check=True,
        capture_output=True,
        text=True,
    )
    shutil.rmtree(destination / ".git")


def assert_external_tool_case_oracles(
    case: ExternalToolCase, observation: dict
) -> None:
    agent_case = case.agent_case_for(observation["mode"])
    interactions = observation["toolInteractions"]
    for required in agent_case.oracles.required_execute_interactions:
        matching = _matching_execute_interactions(interactions, required)
        assert matching, (required, interactions)
    result = observation["result"]
    if agent_case.oracles.validation_level is not None:
        assert result["validation_level"] == agent_case.oracles.validation_level, result
    result_text = json.dumps(result, ensure_ascii=False).lower()
    for requirement in agent_case.oracles.result_requirements:
        assert re.search(requirement, result_text), (requirement, result)


def result_requirements_satisfied(case: ExternalToolCase, observation: dict) -> bool:
    agent_case = case.agent_case_for(observation["mode"])
    result_text = json.dumps(observation["result"], ensure_ascii=False).lower()
    return all(
        re.search(requirement, result_text)
        for requirement in agent_case.oracles.result_requirements
    )


def has_required_external_tool_evidence(
    case: ExternalToolCase, observation: dict
) -> bool:
    agent_case = case.agent_case_for(observation["mode"])
    interactions = observation["toolInteractions"]
    return all(
        _matching_execute_interactions(interactions, required)
        for required in agent_case.oracles.required_execute_interactions
    )


def _matching_execute_interactions(
    interactions: list[dict], required: ExternalToolInteractionOracle
) -> list[dict]:
    return [
        interaction
        for interaction in interactions
        if interaction["tool"] == "execute"
        and re.search(
            required.arguments_pattern,
            json.dumps(interaction["arguments"], ensure_ascii=False),
        )
        and re.search(
            required.result_pattern,
            json.dumps(interaction["result"], ensure_ascii=False),
        )
    ]


def comparison_evidence_score(case: ExternalToolCase, observation: dict) -> int:
    agent_case = case.agent_case_for("compare")
    result_text = json.dumps(observation["result"], ensure_ascii=False).lower()
    return sum(
        bool(re.search(pattern, result_text))
        for pattern in agent_case.oracles.comparison_evidence_patterns
    )


def write_external_tool_comparison_summary(
    path: Path,
    *,
    case: ExternalToolCase,
    without_tool: dict,
    with_tool: dict,
) -> None:
    def compact_observation(observation: dict) -> dict:
        external_tool_interactions = [
            interaction
            for interaction in observation["toolInteractions"]
            if interaction["tool"] == "execute"
            and case.tool
            in json.dumps(interaction["arguments"], ensure_ascii=False).lower()
        ]
        return {
            "externalToolEnabled": observation["externalToolEnabled"],
            "dockerImage": observation["dockerImage"],
            "durationSeconds": observation["durationSeconds"],
            "artifactRoot": observation["artifactRoot"],
            "toolCounts": dict(Counter(observation["toolNames"])),
            "toolErrors": observation["toolErrors"],
            "externalToolInteractions": external_tool_interactions,
            "usedConfiguredTool": has_required_external_tool_evidence(
                case, observation
            ),
            "resultRequirementsSatisfied": result_requirements_satisfied(
                case, observation
            ),
            "result": observation["result"],
            "evidenceScore": comparison_evidence_score(case, observation),
        }

    write_json(
        path,
        {
            "case": case.id,
            "repository": case.checkout.repository if case.checkout else None,
            "commit": case.checkout.commit if case.checkout else None,
            "withoutTool": compact_observation(without_tool),
            "withTool": compact_observation(with_tool),
            "evidenceScores": {
                "withoutTool": comparison_evidence_score(case, without_tool),
                "withTool": comparison_evidence_score(case, with_tool),
                "delta": comparison_evidence_score(case, with_tool)
                - comparison_evidence_score(case, without_tool),
                "maximum": len(
                    case.agent_case_for("compare").oracles.comparison_evidence_patterns
                ),
            },
        },
    )
