from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification.issue import (
    build_issue_verification_backend_config,
    build_issue_verification_filesystem_system_prompt,
    build_issue_verification_system_prompt,
    build_issue_verification_user_prompt,
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


async def verify_issue(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
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
    # you have to pass it originally without stripping, because the patch diff may have leading/trailing whitespace that is significant
    workspace_patch = (
        patch_diff if isinstance(patch_diff, str) and patch_diff.strip() else None
    )
    user_prompt = build_issue_verification_user_prompt(
        issue=issue,
        retry_context=retry_context,
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        workspace_patch=workspace_patch,
    )
    return await run_verification_stage(
        agent_name="issue-verifier",
        verifier_artifacts_path=verifier_artifacts_path,
        attempt_label=attempt_label,
        published_trajectory_path=published_trajectory_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        workspace_patch=workspace_patch,
        mitigation_result=mitigation_result,
        setup_declaration_content=setup_declaration_content,
        build_backend_config=lambda workspace_root_path: build_issue_verification_backend_config(
            workspace_root_path=workspace_root_path,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=build_issue_verification_system_prompt(
            is_retry=retry_context is not None
        ),
        filesystem_system_prompt=build_issue_verification_filesystem_system_prompt(),
        user_prompt=user_prompt,
    )
