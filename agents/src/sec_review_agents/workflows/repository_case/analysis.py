from pathlib import Path

from sec_review_agents.agents.analysis.repository import (
    build_repository_analyzer_backend_config,
    build_repository_analyzer_filesystem_system_prompt,
    build_repository_analyzer_system_prompt,
    build_repository_analyzer_user_prompt,
)
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext


async def analyze_repository_case(
    *,
    workspace_snapshot_tar_path: Path,
    history_path: Path | None,
    incremental_window_path: Path | None,
    analyzer_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    scan_mode: str,
    review_input: str,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> AnalysisStageResult:
    return await run_analysis_stage(
        analyzer_artifacts_path=analyzer_artifacts_path,
        published_trajectory_path=published_trajectory_path,
        agent_name="repository-analyzer",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        setup_declaration_content=setup_declaration_content,
        build_backend_config=lambda stage_workspace_path: build_repository_analyzer_backend_config(
            workspace_root_path=stage_workspace_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            scan_mode=scan_mode,
            runtime_context=runtime_context,
        ),
        system_prompt=build_repository_analyzer_system_prompt(),
        filesystem_system_prompt=build_repository_analyzer_filesystem_system_prompt(
            scan_mode
        ),
        user_prompt=build_repository_analyzer_user_prompt(
            review_input=review_input,
            scan_mode=scan_mode,
        ),
    )
