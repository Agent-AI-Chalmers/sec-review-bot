from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.analysis.issue import (
    build_issue_analyzer_backend_config,
    build_issue_analyzer_filesystem_system_prompt,
    build_issue_analyzer_system_prompt,
    build_issue_analyzer_user_prompt,
)
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.workflows.review_intent import ReviewObjective


async def analyze_issue(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    analyzer_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    review_objective: ReviewObjective,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    return await run_analysis_stage(
        analyzer_artifacts_path=analyzer_artifacts_path,
        published_trajectory_path=published_trajectory_path,
        agent_name="issue-analyzer",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        setup_declaration_content=setup_declaration_content,
        build_backend_config=lambda stage_workspace_path: build_issue_analyzer_backend_config(
            workspace_root_path=stage_workspace_path,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=build_issue_analyzer_system_prompt(review_objective),
        filesystem_system_prompt=build_issue_analyzer_filesystem_system_prompt(),
        user_prompt=build_issue_analyzer_user_prompt(
            issue=issue,
        ),
    )
