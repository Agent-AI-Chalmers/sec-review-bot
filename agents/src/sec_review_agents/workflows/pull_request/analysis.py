from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.analysis.pull_request import (
    build_pr_analyzer_backend_config,
    build_pr_analyzer_filesystem_system_prompt,
    build_pr_analyzer_system_prompt,
    build_pr_analyzer_user_prompt,
)
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext


async def analyze_pull_request(
    *,
    pr: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    incremental_window_path: Path,
    analyzer_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    return await run_analysis_stage(
        analyzer_artifacts_path=analyzer_artifacts_path,
        published_trajectory_path=published_trajectory_path,
        agent_name="pull-request-analyzer",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        setup_declaration_content=setup_declaration_content,
        build_backend_config=lambda stage_workspace_path: build_pr_analyzer_backend_config(
            workspace_root_path=stage_workspace_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            runtime_context=runtime_context,
        ),
        system_prompt=build_pr_analyzer_system_prompt(),
        filesystem_system_prompt=build_pr_analyzer_filesystem_system_prompt(),
        user_prompt=build_pr_analyzer_user_prompt(
            pr=pr,
        ),
    )
