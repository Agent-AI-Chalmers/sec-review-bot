from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation import issue as issue_mitigation_agent
from sec_review_agents.review_stages.mitigation.stage import (
    run_mitigation_stage,
)
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.workflows.review_intent import (
    REPAIR_MODE_TEST_CHANGES_ALLOWED,
    RepairMode,
)


async def mitigate_issue_with_self_check(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    mitigator_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    analysis_result: Mapping[str, Any],
    repair_mode: RepairMode = REPAIR_MODE_TEST_CHANGES_ALLOWED,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    return await run_mitigation_stage(
        agent_name="issue-mitigator-self-check",
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        retry_context=None,
        build_backend=lambda workspace_root: issue_mitigation_agent.create_issue_mitigation_backend(
            workspace_root=workspace_root,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=issue_mitigation_agent.build_issue_self_check_mitigation_system_prompt(
            repair_mode=repair_mode
        ),
        filesystem_system_prompt=(
            issue_mitigation_agent.build_issue_self_check_mitigation_filesystem_system_prompt()
        ),
        user_prompt=issue_mitigation_agent.build_issue_self_check_mitigation_user_prompt(
            issue=issue,
            analysis_result=analysis_result,
            retry_context=None,
        ),
    )
