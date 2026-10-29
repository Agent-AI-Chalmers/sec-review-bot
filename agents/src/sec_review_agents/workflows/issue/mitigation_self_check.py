from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation.issue import (
    build_issue_self_check_mitigation_filesystem_system_prompt,
    build_issue_self_check_mitigation_system_prompt,
    build_issue_self_check_mitigation_user_prompt,
    create_issue_mitigation_backend,
)
from sec_review_agents.review_stages.mitigation.stage import (
    run_mitigation_stage,
)
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.workflows.review_intent import (
    TEST_CHANGES_ALLOW,
    TestChangesPolicy,
)


async def mitigate_issue_with_self_check(
    *,
    issue: Mapping[str, Any],
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    mitigator_artifacts_path: Path,
    published_trajectory_path: Path | None = None,
    analysis_result: Mapping[str, Any],
    test_changes: TestChangesPolicy = TEST_CHANGES_ALLOW,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    return await run_mitigation_stage(
        agent_name="issue-mitigator-self-check",
        mitigator_artifacts_path=mitigator_artifacts_path,
        setup_declaration_content=setup_declaration_content,
        published_trajectory_path=published_trajectory_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        retry_context=None,
        build_backend=lambda workspace_root, memory_path_view: create_issue_mitigation_backend(
            workspace_root=workspace_root,
            history_path=history_path,
            memory_path_view=memory_path_view,
            runtime_context=runtime_context,
        ),
        system_prompt=build_issue_self_check_mitigation_system_prompt(
            test_changes=test_changes
        ),
        filesystem_system_prompt=build_issue_self_check_mitigation_filesystem_system_prompt(),
        user_prompt=build_issue_self_check_mitigation_user_prompt(
            issue=issue,
            analysis_result=analysis_result,
            retry_context=None,
        ),
    )
