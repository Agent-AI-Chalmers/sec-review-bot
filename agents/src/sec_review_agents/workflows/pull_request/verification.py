from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification.pull_request import (
    build_pr_verification_backend_config,
    build_pr_verification_filesystem_system_prompt,
    build_pr_verification_system_prompt,
    build_pr_verification_user_prompt,
)
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.feedback_loop import FeedbackRetryContext
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.review_stages.verification.stage import (
    reset_verification_attempt_artifacts,
    run_verification_stage,
    verification_attempt_label,
)
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext


async def verify_pull_request(
    *,
    pr: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    incremental_window_path: Path,
    verifier_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    analysis_result: AnalysisStageResult,
    mitigation_result: MitigationStageResult | None,
    retry_context: FeedbackRetryContext | None,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> VerificationStageResult:
    attempt_label = verification_attempt_label(retry_context)
    reset_verification_attempt_artifacts(
        verifier_artifacts_path,
        attempt_label=attempt_label,
    )
    patch_diff = mitigation_result.patch_diff if mitigation_result is not None else None
    workspace_patch = (
        patch_diff if isinstance(patch_diff, str) and patch_diff.strip() else None
    )
    user_prompt = build_pr_verification_user_prompt(
        pr=pr,
        retry_context=retry_context,
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        workspace_patch=workspace_patch,
    )
    return await run_verification_stage(
        agent_name="pull-request-verifier",
        verifier_artifacts_path=verifier_artifacts_path,
        attempt_label=attempt_label,
        published_trajectory_path=published_trajectory_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        workspace_patch=workspace_patch,
        mitigation_result=mitigation_result,
        setup_declaration_content=setup_declaration_content,
        build_backend_config=lambda workspace_root_path: build_pr_verification_backend_config(
            workspace_root_path=workspace_root_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            runtime_context=runtime_context,
        ),
        system_prompt=build_pr_verification_system_prompt(
            is_retry=retry_context is not None
        ),
        filesystem_system_prompt=build_pr_verification_filesystem_system_prompt(),
        user_prompt=user_prompt,
    )
