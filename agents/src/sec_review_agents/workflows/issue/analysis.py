from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.analysis import issue as issue_analysis_agent
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.workflows.review_intent import ReviewObjective


async def analyze_issue(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    analyzer_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    review_objective: ReviewObjective,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    return await run_analysis_stage(
        analyzer_artifacts_path=analyzer_artifacts_path,
        published_transcript_path=published_transcript_path,
        agent_name="issue-analyzer",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        build_backend=lambda stage_workspace_path: issue_analysis_agent.create_issue_analyzer_backend(
            workspace_root_path=stage_workspace_path,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=issue_analysis_agent.build_issue_analyzer_system_prompt(
            review_objective
        ),
        filesystem_system_prompt=(
            issue_analysis_agent.build_issue_analyzer_filesystem_system_prompt()
        ),
        user_prompt=issue_analysis_agent.build_issue_analyzer_user_prompt(
            issue=issue,
        ),
    )
