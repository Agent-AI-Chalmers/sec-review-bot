from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification import pull_request as pr_verification_agent
from sec_review_agents.review_stages.verification.stage import (
    reset_verification_attempt_artifacts,
    run_verification_stage,
    verification_attempt_label,
)
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.workflows.pull_request.incremental_window import (
    load_pr_diff_metadata,
)


async def verify_pull_request(
    *,
    pr: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    incremental_window_path: Path,
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
    diff_metadata = load_pr_diff_metadata(incremental_window_path)
    workspace_patch = (
        str((mitigation_result or {}).get("patch_diff") or "").strip() or None
    )
    user_prompt = pr_verification_agent.build_pr_verification_user_prompt(
        pr=pr,
        retry_context=retry_context,
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        diff_metadata=diff_metadata,
        workspace_patch=workspace_patch,
    )
    return await run_verification_stage(
        agent_name="pull-request-verifier",
        verifier_artifacts_path=verifier_artifacts_path,
        attempt_label=attempt_label,
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        workspace_patch=workspace_patch,
        mitigation_result=mitigation_result,
        build_backend=lambda workspace_root_path: pr_verification_agent.create_pr_verification_backend(
            workspace_root_path=workspace_root_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            runtime_context=runtime_context,
        ),
        system_prompt=pr_verification_agent.build_pr_verification_system_prompt(
            is_retry=isinstance(retry_context, Mapping)
        ),
        filesystem_system_prompt=(
            pr_verification_agent.build_pr_verification_filesystem_system_prompt()
        ),
        user_prompt=user_prompt,
    )
