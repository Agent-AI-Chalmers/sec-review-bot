from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation.issue import (
    build_issue_mitigation_backend_config,
    build_issue_mitigation_filesystem_system_prompt,
    build_issue_mitigation_system_prompt,
    build_issue_mitigation_user_prompt,
)
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.feedback_loop import FeedbackRetryContext
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.mitigation.stage import run_mitigation_stage
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.workflows.review_intent import (
    TestChangesPolicy,
)


async def mitigate_issue(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    mitigator_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    test_changes: TestChangesPolicy,
    analysis_result: AnalysisStageResult,
    retry_context: FeedbackRetryContext | None = None,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> MitigationStageResult:
    return await run_mitigation_stage(
        agent_name="issue-mitigator",
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_trajectory_path=published_trajectory_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        retry_context=retry_context,
        setup_declaration_content=setup_declaration_content,
        build_backend_config=lambda workspace_root: build_issue_mitigation_backend_config(
            workspace_root=workspace_root,
            history_path=history_path,
            runtime_context=runtime_context,
        ),
        system_prompt=build_issue_mitigation_system_prompt(
            test_changes=test_changes,
            is_retry=retry_context is not None,
        ),
        filesystem_system_prompt=build_issue_mitigation_filesystem_system_prompt(),
        user_prompt=build_issue_mitigation_user_prompt(
            issue=issue,
            retry_context=retry_context,
            analysis_result=analysis_result,
        ),
    )
