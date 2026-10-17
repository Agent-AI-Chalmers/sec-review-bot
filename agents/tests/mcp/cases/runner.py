import json
import re
import shutil
from pathlib import Path
from unittest.mock import patch

from sec_review_agents.workflows.repository_case.verification import (
    verify_repository_case,
)
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.integration.llm.transcript_artifact_helpers import (
    tool_interactions_from_transcript,
    tool_usage_from_transcript,
)
from tests.mcp.cases.models import McpCase, McpCaseMode


async def run_mcp_case(
    case: McpCase,
    *,
    mode: McpCaseMode,
    run_root: Path,
    docker_image: str,
    mcp_enabled: bool,
) -> dict:
    if mode == "capability":
        raise ValueError("capability cases use the deterministic capability runner")
    agent_case = case.agent_case_for(mode)
    run_root.mkdir(parents=True, exist_ok=False)
    workspace = run_root / "workspace"
    snapshot = run_root / "workspace.snapshot.tar"
    artifacts = run_root / "artifacts" / "verifier"
    shutil.copytree(case.workspace_source, workspace)
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=snapshot)

    with patch.dict(
        "os.environ",
        {
            "AGENT_SANDBOX_BACKEND": "docker",
            "AGENT_DOCKER_IMAGE": docker_image,
            "AGENT_DOCKER_NETWORK_MODE": "none",
            "AGENT_MCP_ENABLED": "true" if mcp_enabled else "false",
            "AGENT_MEMORY_ENABLED": "false",
            "AGENT_SKILLS_ENABLED": "false",
        },
        clear=False,
    ):
        result = await verify_repository_case(
            workspace_snapshot_tar_path=snapshot,
            history_path=None,
            incremental_window_path=None,
            verifier_artifacts_path=artifacts,
            scan_mode="full",
            review_input=agent_case.review_input,
            analysis_result={
                "overview": agent_case.analysis_overview,
                "verdict": "confirmed-vulnerability",
            },
            mitigation_result={
                "overview": "No mitigation patch was supplied.",
                "changed_files": [],
                "patch_diff": "",
            },
            setup_declaration_content=(
                case.setup_path.read_text(encoding="utf-8")
                if case.setup_path is not None
                else None
            ),
        )

    transcript = artifacts / "transcripts" / "initial.json"
    usage = tool_usage_from_transcript(transcript)
    return {
        "case": case.id,
        "mode": mode,
        "mcpEnabled": mcp_enabled,
        "artifactRoot": str(run_root),
        "toolNames": usage["toolNames"],
        "toolErrors": usage["toolErrors"],
        "toolInteractions": tool_interactions_from_transcript(transcript),
        "result": result,
    }


def assert_mcp_case_oracles(case: McpCase, observation: dict) -> None:
    agent_case = case.agent_case_for(observation["mode"])
    interactions = observation["toolInteractions"]
    for required in agent_case.oracles.required_tool_interactions:
        matching = [
            interaction
            for interaction in interactions
            if interaction["tool"] == required.tool
            and re.search(
                required.arguments_pattern,
                json.dumps(interaction["arguments"], ensure_ascii=False),
            )
            and re.search(
                required.result_pattern,
                json.dumps(interaction["result"], ensure_ascii=False),
            )
        ]
        assert matching, (required, interactions)
    for prefix in agent_case.oracles.forbidden_tool_error_prefixes:
        matching_errors = [
            error
            for error in observation["toolErrors"]
            if error["tool"].startswith(prefix)
        ]
        assert not matching_errors, matching_errors
    result = observation["result"]
    assert result["validation_level"] == agent_case.oracles.validation_level, result
    result_text = json.dumps(result, ensure_ascii=False).lower()
    for requirement in agent_case.oracles.result_requirements:
        assert re.search(requirement, result_text), (requirement, result)
