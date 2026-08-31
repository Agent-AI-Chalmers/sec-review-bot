from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation import pull_request as pr_mitigation_agent
from sec_review_agents.review_stages.mitigation.stage import run_mitigation_stage
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.workflows.pull_request.incremental_window import (
    load_pr_diff_metadata,
)
from sec_review_agents.workflows.review_intent import (
    REPAIR_MODE_TEST_CHANGES_ALLOWED,
    RepairMode,
)


async def mitigate_pull_request(
    *,
    pr: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    incremental_window_path: Path,
    mitigator_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    analysis_result: Mapping[str, Any],
    retry_context: Mapping[str, Any] | None = None,
    repair_mode: RepairMode = REPAIR_MODE_TEST_CHANGES_ALLOWED,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    diff_metadata = load_pr_diff_metadata(incremental_window_path)
    return await run_mitigation_stage(
        agent_name="pull-request-mitigator",
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        retry_context=retry_context,
        build_backend=lambda workspace_root: pr_mitigation_agent.create_pr_mitigation_backend(
            workspace_root=workspace_root,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            runtime_context=runtime_context,
        ),
        system_prompt=pr_mitigation_agent.build_pr_mitigation_system_prompt(
            repair_mode=repair_mode, is_retry=isinstance(retry_context, dict)
        ),
        filesystem_system_prompt=(
            pr_mitigation_agent.build_pr_mitigation_filesystem_system_prompt()
        ),
        user_prompt=pr_mitigation_agent.build_pr_mitigation_user_prompt(
            pr=pr,
            retry_context=retry_context,
            analysis_result=analysis_result,
            diff_metadata=diff_metadata,
        ),
    )
