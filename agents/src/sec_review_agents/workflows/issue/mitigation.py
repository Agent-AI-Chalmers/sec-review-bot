from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation import issue as issue_mitigation_agent
from sec_review_agents.review_stages.mitigation.stage import run_mitigation_stage
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.workflows.review_intent import (
    RepairMode,
)


async def mitigate_issue(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    mitigator_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    repair_mode: RepairMode,
    analysis_result: Mapping[str, Any],
    retry_context: Mapping[str, Any] | None = None,
    runtime_context: RunnerRuntimeContext | None = None,
) -> dict[str, Any]:
    return await run_mitigation_stage(
        agent_name="issue-mitigator",
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        retry_context=retry_context,
        build_backend=lambda workspace_root: issue_mitigation_agent.create_issue_mitigation_backend(
            workspace_root=workspace_root,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=issue_mitigation_agent.build_issue_mitigation_system_prompt(
            repair_mode=repair_mode,
            is_retry=isinstance(retry_context, Mapping),
        ),
        filesystem_system_prompt=(
            issue_mitigation_agent.build_issue_mitigation_filesystem_system_prompt()
        ),
        user_prompt=issue_mitigation_agent.build_issue_mitigation_user_prompt(
            issue=issue,
            retry_context=retry_context,
            analysis_result=analysis_result,
        ),
    )
