from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.analysis import pull_request as pr_analysis_agent
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.workflows.pull_request.incremental_window import (
    load_pr_diff_metadata,
)


async def analyze_pull_request(
    *,
    pr: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    incremental_window_path: Path,
    analyzer_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    diff_metadata = load_pr_diff_metadata(incremental_window_path)
    return await run_analysis_stage(
        analyzer_artifacts_path=analyzer_artifacts_path,
        published_transcript_path=published_transcript_path,
        agent_name="pull-request-analyzer",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        build_backend=lambda stage_workspace_path: pr_analysis_agent.create_pr_analyzer_backend(
            workspace_root_path=stage_workspace_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            runtime_context=runtime_context,
        ),
        system_prompt=pr_analysis_agent.build_pr_analyzer_system_prompt(),
        filesystem_system_prompt=(
            pr_analysis_agent.build_pr_analyzer_filesystem_system_prompt()
        ),
        user_prompt=pr_analysis_agent.build_pr_analyzer_user_prompt(
            pr=pr,
            diff_metadata=diff_metadata,
        ),
    )
