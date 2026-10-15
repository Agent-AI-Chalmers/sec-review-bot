from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sec_review_agents.agents.mitigation import (
    repository as repository_mitigation_agent,
)
from sec_review_agents.review_stages.mitigation.stage import run_mitigation_stage
from sec_review_agents.runtime.runtime_config import RunnerRuntimeContext
from sec_review_agents.workflows.review_intent import (
    TEST_CHANGES_ALLOW,
    TestChangesPolicy,
)


async def mitigate_repository_case(
    *,
    workspace_snapshot_tar_path: Path,
    history_path: Path | None,
    incremental_window_path: Path | None,
    mitigator_artifacts_path: Path,
    published_transcript_path: Path | None = None,
    scan_mode: str,
    review_input: str,
    analysis_result: Mapping[str, Any],
    retry_context: Mapping[str, Any] | None = None,
    test_changes: TestChangesPolicy = TEST_CHANGES_ALLOW,
    runtime_context: RunnerRuntimeContext | None = None,
    trusted_setup_path: Path | None = None,
) -> dict[str, Any]:
    return await run_mitigation_stage(
        agent_name="repository-mitigator",
        mitigator_artifacts_path=mitigator_artifacts_path,
        published_transcript_path=published_transcript_path,
        baseline_snapshot_tar_path=workspace_snapshot_tar_path,
        retry_context=retry_context,
        trusted_setup_path=trusted_setup_path,
        build_backend=lambda workspace_root: repository_mitigation_agent.create_repository_mitigation_backend(
            workspace_root=workspace_root,
            history_path=history_path,
            incremental_window_path=incremental_window_path,
            scan_mode=scan_mode,
            runtime_context=runtime_context,
            trusted_setup_path=trusted_setup_path,
        ),
        system_prompt=repository_mitigation_agent.build_repository_mitigation_system_prompt(
            test_changes=test_changes, is_retry=isinstance(retry_context, Mapping)
        ),
        filesystem_system_prompt=(
            repository_mitigation_agent.build_repository_mitigation_filesystem_system_prompt(
                scan_mode
            )
        ),
        user_prompt=repository_mitigation_agent.build_repository_mitigation_user_prompt(
            review_input=review_input,
            scan_mode=scan_mode,
            retry_context=retry_context,
            analysis_result=analysis_result,
        ),
    )
