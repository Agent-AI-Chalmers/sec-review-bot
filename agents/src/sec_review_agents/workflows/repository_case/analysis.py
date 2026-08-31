from pathlib import Path
from typing import Any

from sec_review_agents.agents.analysis import repository as repository_analysis_agent
from sec_review_agents.review_stages.analysis.stage import run_analysis_stage
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext


async def analyze_repository_case(
    *,
    workspace_snapshot_tar_path: Path,
    history_path: Path | None,
    incremental_window_path: Path | None,
    analyzer_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    scan_mode: str,
    review_input: str,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    return await run_analysis_stage(
        analyzer_artifacts_path=analyzer_artifacts_path,
        published_transcript_path=published_transcript_path,
        agent_name="repository-analyzer",
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        build_backend=lambda stage_workspace_path: repository_analysis_agent.create_repository_analyzer_backend(
            workspace_root_path=stage_workspace_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            scan_mode=scan_mode,
            runtime_context=runtime_context,
        ),
        system_prompt=repository_analysis_agent.build_repository_analyzer_system_prompt(),
        filesystem_system_prompt=(
            repository_analysis_agent.build_repository_analyzer_filesystem_system_prompt(
                scan_mode
            )
        ),
        user_prompt=repository_analysis_agent.build_repository_analyzer_user_prompt(
            review_input=review_input,
            scan_mode=scan_mode,
        ),
    )
