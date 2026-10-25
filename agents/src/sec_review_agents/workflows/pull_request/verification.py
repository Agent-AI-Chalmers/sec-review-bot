from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.verification.pull_request import (
    build_pr_verification_filesystem_system_prompt,
    build_pr_verification_system_prompt,
    build_pr_verification_user_prompt,
    create_pr_verification_backend,
)
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
    published_transcript_path: Path | None = None,
    analysis_result: Mapping[str, Any],
    mitigation_result: Mapping[str, Any] | None,
    retry_context: Mapping[str, Any] | None,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    attempt_label = verification_attempt_label(retry_context)
    reset_verification_attempt_artifacts(
        verifier_artifacts_path,
        attempt_label=attempt_label,
    )
    patch_diff = (mitigation_result or {}).get("patch_diff")
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
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        workspace_patch=workspace_patch,
        mitigation_result=mitigation_result,
        setup_declaration_content=setup_declaration_content,
        build_backend=lambda workspace_root_path, memory_path_view: create_pr_verification_backend(
            workspace_root_path=workspace_root_path,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            memory_path_view=memory_path_view,
            runtime_context=runtime_context,
        ),
        system_prompt=build_pr_verification_system_prompt(
            is_retry=isinstance(retry_context, Mapping)
        ),
        filesystem_system_prompt=build_pr_verification_filesystem_system_prompt(),
        user_prompt=user_prompt,
    )
