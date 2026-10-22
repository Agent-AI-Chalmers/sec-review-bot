from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation import pull_request as pr_mitigation_agent
from sec_review_agents.review_stages.mitigation.stage import run_mitigation_stage
from sec_review_agents.runtime.runtime_config import ExecutionRuntimeContext
from sec_review_agents.workflows.review_intent import (
    TEST_CHANGES_ALLOW,
    TestChangesPolicy,
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
    test_changes: TestChangesPolicy = TEST_CHANGES_ALLOW,
    runtime_context: ExecutionRuntimeContext | None = None,
    setup_declaration_content: str | None = None,
) -> dict[str, Any]:
    return await run_mitigation_stage(
        agent_name="pull-request-mitigator",
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        retry_context=retry_context,
        setup_declaration_content=setup_declaration_content,
        build_backend=lambda workspace_root: pr_mitigation_agent.create_pr_mitigation_backend(
            workspace_root=workspace_root,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            runtime_context=runtime_context,
        ),
        system_prompt=pr_mitigation_agent.build_pr_mitigation_system_prompt(
            test_changes=test_changes, is_retry=isinstance(retry_context, dict)
        ),
        filesystem_system_prompt=(
            pr_mitigation_agent.build_pr_mitigation_filesystem_system_prompt()
        ),
        user_prompt=pr_mitigation_agent.build_pr_mitigation_user_prompt(
            pr=pr,
            retry_context=retry_context,
            analysis_result=analysis_result,
        ),
    )
