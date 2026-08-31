from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification import issue as issue_verification_agent
from sec_review_agents.review_stages.verification.stage import (
    reset_verification_attempt_artifacts,
    run_verification_stage,
    verification_attempt_label,
)
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext


async def verify_issue(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    verifier_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    analysis_result: Mapping[str, Any],
    mitigation_result: Mapping[str, Any] | None,
    retry_context: Mapping[str, Any] | None,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    attempt_label = verification_attempt_label(retry_context)
    reset_verification_attempt_artifacts(
        verifier_artifacts_path,
        attempt_label=attempt_label,
    )
    workspace_patch = (
        str((mitigation_result or {}).get("patch_diff") or "").strip() or None
    )
    user_prompt = issue_verification_agent.build_issue_verification_user_prompt(
        issue=issue,
        retry_context=retry_context,
        analysis_result=analysis_result,
        mitigation_result=mitigation_result or {},
        workspace_patch=workspace_patch,
    )
    return await run_verification_stage(
        agent_name="issue-verifier",
        verifier_artifacts_path=verifier_artifacts_path,
        attempt_label=attempt_label,
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        workspace_patch=workspace_patch,
        mitigation_result=mitigation_result,
        build_backend=lambda workspace_root_path: issue_verification_agent.create_issue_verification_backend(
            workspace_root_path=workspace_root_path,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=issue_verification_agent.build_issue_verification_system_prompt(
            is_retry=isinstance(retry_context, Mapping)
        ),
        filesystem_system_prompt=(
            issue_verification_agent.build_issue_verification_filesystem_system_prompt()
        ),
        user_prompt=user_prompt,
    )
