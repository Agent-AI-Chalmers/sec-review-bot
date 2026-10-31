from pathlib import Path

from sec_review_agents.agents.cvss.repository import (
    REPOSITORY_CVSS_V4_SCORER_NAME,
    build_repository_cvss_v4_filesystem_system_prompt,
    build_repository_cvss_v4_system_prompt,
    build_repository_cvss_v4_user_prompt,
    create_repository_cvss_backend,
)
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.cvss.result import (
    CvssStageResult,
    build_skipped_cvss_v4_result,
)
from sec_review_agents.review_stages.cvss.stage import (
    is_cvss_v4_scoring_target,
    persist_cvss_stage_result,
    run_cvss_v4_scoring_stage,
)

CVSS_NO_TARGET_REASON = "Analyzer did not retain a scoreable confirmed narrative; CVSS v4 scoring was skipped."


async def score_repository_cvss_v4(
    *,
    cvss_artifacts_path: Path,
    workspace_snapshot_tar_path: Path,
    review_input: str,
    analysis_result: AnalysisStageResult,
) -> CvssStageResult:
    if not is_cvss_v4_scoring_target(analysis_result):
        result = build_skipped_cvss_v4_result(reason=CVSS_NO_TARGET_REASON)
        persist_cvss_stage_result(
            cvss_artifacts_path=cvss_artifacts_path, result=result
        )
        return result

    return await run_cvss_v4_scoring_stage(
        cvss_artifacts_path=cvss_artifacts_path,
        agent_name=REPOSITORY_CVSS_V4_SCORER_NAME,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        build_backend=lambda stage_workspace_path: create_repository_cvss_backend(
            workspace_root_path=stage_workspace_path,
        ),
        system_prompt=build_repository_cvss_v4_system_prompt(),
        filesystem_system_prompt=build_repository_cvss_v4_filesystem_system_prompt(),
        user_prompt=build_repository_cvss_v4_user_prompt(
            review_input=review_input,
            analysis_result=analysis_result,
        ),
    )
