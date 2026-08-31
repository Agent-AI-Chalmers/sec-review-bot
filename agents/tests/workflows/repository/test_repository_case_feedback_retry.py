from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from temporalio import activity
from temporalio.worker import Worker

from sec_review_agents.workflows.repository.case_execution_input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.repository.workflow import (
    RepositoryCaseReviewRequest,
    RepositoryCaseReviewWorkflow,
)
from sec_review_agents.workflows.repository_case import stage as case_workflow
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.temporal_test_utils import temporal_time_skipping_environment


def repository_case_execution_input(case_id: str) -> RepositoryCaseExecutionInput:
    return {
        "case_id": case_id,
        "review_input": f"Prepared {case_id} review input.",
        "workspace_snapshot_tar_path": "/tmp/workspace.snapshot.tar",
        "history_path": "/tmp/history",
        "scan_mode": "full",
        "incremental_window_path": None,
        "repair_mode": REPAIR_MODE_TEST_CHANGES_ALLOWED,
    }


@pytest.mark.asyncio
async def test_repository_case_mitigation_exception_is_raised_for_activity_retry(
    tmp_path: Path,
) -> None:
    with pytest.raises(RuntimeError, match="mitigator exploded"):
        await _mitigation_error_stage_result(tmp_path)


@pytest.mark.asyncio
async def test_repository_case_analyzer_exception_is_raised_for_activity_retry(
    tmp_path: Path,
) -> None:
    case_input = repository_case_execution_input("case-analysis-error")

    with (
        patch.object(
            case_workflow,
            "analyze_repository_case",
            side_effect=RuntimeError("analyzer exploded"),
        ),
        pytest.raises(RuntimeError, match="analyzer exploded"),
    ):
        await case_workflow.analyze_repository_case_stage(
            case_input,
            analyzer_artifacts_path=tmp_path / "analyzer",
            runtime_context=None,
        )


async def _mitigation_error_stage_result(tmp_path: Path) -> dict[str, Any]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "app.py").write_text("print('hello')\n", encoding="utf-8")
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=snapshot_tar)

    case_input = repository_case_execution_input("case-mitigation-error") | {
        "workspace_snapshot_tar_path": str(snapshot_tar),
        "history_path": str(tmp_path / "history"),
    }

    with (
        patch(
            "sec_review_agents.agents.mitigation.repository.create_repository_mitigation_backend",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.create_mitigation_agent_graph",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.invoke_agent_runtime_graph",
            side_effect=RuntimeError("mitigator exploded"),
        ),
    ):
        return await case_workflow.run_repository_case_mitigation_stage(
            case_input,
            {
                "verdict": "confirmed-vulnerability",
                "narratives": [{"verdict": "confirmed-vulnerability"}],
            },
            None,
            None,
            mitigator_artifacts_path=tmp_path / "mitigator",
        )


@pytest.mark.asyncio
async def test_repository_case_verifier_exception_is_raised_for_activity_retry(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=snapshot_tar)

    case_input = repository_case_execution_input("case-verification-error") | {
        "workspace_snapshot_tar_path": str(snapshot_tar),
        "history_path": str(tmp_path / "history"),
    }

    with (
        patch(
            "sec_review_agents.agents.verification.repository.create_repository_verification_backend",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage.create_verification_agent_graph",
            return_value=object(),
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage.invoke_agent_runtime_graph",
            side_effect=RuntimeError("verifier exploded"),
        ),
        pytest.raises(RuntimeError, match="verifier exploded"),
    ):
        await case_workflow.run_repository_case_verification_stage(
            case_input,
            {"verdict": "confirmed-vulnerability"},
            {"changed_files": []},
            None,
            None,
            verifier_artifacts_path=tmp_path / "verifier",
        )


@pytest.mark.asyncio
async def test_repository_case_without_patch_does_not_retry_verification() -> None:
    state = _CaseWorkflowState(
        mitigation_results=[
            {
                "changed_files": [],
                "outcome": "patched",
            }
        ],
        verification_results=[
            {
                "patch_coverage": "no-patch",
                "resolution_next_step": "manual-review",
                "patch_findings": [],
                "verification_findings": [],
            }
        ],
    )

    result = await _run_case_workflow(state)

    assert state.mitigation_retry_contexts == [None]
    assert state.verification_retry_contexts == [None]
    assert state.archive_retry_contexts == []
    assert result["review_record"]["verification"]["patch_coverage"] == "no-patch"
    assert "diagnostics" not in result


@pytest.mark.asyncio
async def test_repository_case_workflow_retries_and_passes_verifier_history() -> None:
    state = _CaseWorkflowState(
        mitigation_results=[
            {
                "overview": "applied",
                "changed_files": ["case-0.py"],
                "residual_risks": [],
            },
            {
                "overview": "revised",
                "changed_files": ["case-1.py"],
                "residual_risks": [],
            },
        ],
        verification_results=[
            {
                "overview": "Patch still needs revision.",
                "review_target_claim": "target claim",
                "patch_coverage": "partial",
                "resolution_next_step": "retry-ai",
                "validation_level": "static",
                "patch_findings": ["needs revision"],
                "verification_findings": ["first verifier"],
                "residual_risks": [],
            },
            {
                "overview": "Patch fully covers the target claim.",
                "review_target_claim": "target claim",
                "patch_coverage": "full",
                "resolution_next_step": "none",
                "validation_level": "static",
                "patch_findings": [],
                "verification_findings": ["second verifier"],
                "residual_risks": [],
            },
        ],
    )

    result = await _run_case_workflow(state)

    assert len(state.mitigation_retry_contexts) == 2
    assert state.mitigation_retry_contexts[0] is None
    assert (state.mitigation_retry_contexts[1] or {}).get("retry_index") == 1
    assert len(state.verification_retry_contexts) == 2
    assert state.verification_retry_contexts[0] is None
    assert (state.verification_retry_contexts[1] or {}).get("retry_index") == 1
    assert len(state.archive_retry_contexts) == 1
    assert result["review_record"]["verification"]["patch_coverage"] == "full"
    assert result["disposition"] == "keep"
    assert "diagnostics" not in result


class _CaseWorkflowState:
    def __init__(
        self,
        *,
        mitigation_results: list[dict[str, Any]],
        verification_results: list[dict[str, Any]],
    ) -> None:
        self.mitigation_results = list(mitigation_results)
        self.verification_results = list(verification_results)
        self.mitigation_retry_contexts: list[dict[str, Any] | None] = []
        self.verification_retry_contexts: list[dict[str, Any] | None] = []
        self.archive_retry_contexts: list[dict[str, Any]] = []


async def _run_case_workflow(state: _CaseWorkflowState) -> dict[str, Any]:
    @activity.defn(name="prepare_repository_case_activity")
    def fake_prepare_repository_case(request: dict[str, Any]) -> dict[str, Any]:
        return {
            "case_execution_input": request["case_execution_input"],
            "artifact_paths": {
                "analyzer": "/tmp/cases/case-1/analyzer",
                "cvss": "/tmp/cases/case-1/cvss",
                "mitigator": "/tmp/cases/case-1/mitigator",
                "verifier": "/tmp/cases/case-1/verifier",
            },
        }

    @activity.defn(name="analyze_repository_case_activity")
    def fake_analyze_repository_case(
        _prepared_case: dict[str, Any],
        _runtime_context: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "overview": "confirmed",
            "verdict": "confirmed-vulnerability",
            "narratives": [{"verdict": "confirmed-vulnerability"}],
        }

    @activity.defn(name="score_repository_case_cvss_activity")
    def fake_score_repository_case_cvss(
        _prepared_case: dict[str, Any],
        _analysis_result: dict[str, Any],
    ) -> dict[str, Any]:
        return {"outcome": "scored"}

    @activity.defn(name="build_failed_repository_case_cvss_result_activity")
    def fake_build_failed_repository_case_cvss_result(
        _prepared_case: dict[str, Any],
        error: str,
    ) -> None:
        _ = error

    @activity.defn(name="mitigate_repository_case_activity")
    def fake_mitigate_repository_case(
        _prepared_case: dict[str, Any],
        _analysis_result: dict[str, Any],
        retry_context: dict[str, Any] | None,
        _runtime_context: dict[str, Any],
    ) -> dict[str, Any]:
        state.mitigation_retry_contexts.append(retry_context)
        return state.mitigation_results.pop(0)

    @activity.defn(name="verify_repository_case_activity")
    def fake_verify_repository_case(
        _prepared_case: dict[str, Any],
        _analysis_result: dict[str, Any],
        _mitigation_result: dict[str, Any] | None,
        retry_context: dict[str, Any] | None,
        _runtime_context: dict[str, Any],
    ) -> dict[str, Any]:
        state.verification_retry_contexts.append(retry_context)
        if retry_context is not None:
            history = retry_context.get("history") or []
            assert len(history) == 1
            assert history[0]["patch_coverage"] == "partial"
            assert history[0]["resolution_next_step"] == "retry-ai"
        return state.verification_results.pop(0)

    @activity.defn(name="archive_repository_case_feedback_attempt_activity")
    def fake_archive_repository_case_feedback_attempt(
        _prepared_case: dict[str, Any],
        retry_context: dict[str, Any],
    ) -> None:
        state.archive_retry_contexts.append(retry_context)

    @activity.defn(name="build_repository_case_result_activity")
    def fake_build_repository_case_result(
        prepared_case: dict[str, Any],
        _analysis_result: dict[str, Any],
        cvss_result: dict[str, Any] | None,
        mitigation_result: dict[str, Any] | None,
        verifier_result: dict[str, Any] | None,
    ) -> dict[str, Any]:
        return {
            "case_id": prepared_case["case_execution_input"]["case_id"],
            "disposition": (
                "keep"
                if (verifier_result or {}).get("patch_coverage") == "full"
                else "blocked"
            ),
            "review_record": {
                "cvss": cvss_result,
                "mitigation": mitigation_result or {},
                "verification": verifier_result or {},
            },
        }

    async with temporal_time_skipping_environment() as env:
        with ThreadPoolExecutor(max_workers=4) as executor:
            async with Worker(
                env.client,
                task_queue="repository-case-test",
                workflows=[RepositoryCaseReviewWorkflow],
                activities=[
                    fake_prepare_repository_case,
                    fake_analyze_repository_case,
                    fake_score_repository_case_cvss,
                    fake_build_failed_repository_case_cvss_result,
                    fake_mitigate_repository_case,
                    fake_verify_repository_case,
                    fake_archive_repository_case_feedback_attempt,
                    fake_build_repository_case_result,
                ],
                activity_executor=executor,
            ):
                request: RepositoryCaseReviewRequest = {
                    "run_id": "run-repo-case",
                    "case_execution_input": repository_case_execution_input("case-1"),
                    "cases_artifacts_path": "/tmp/cases",
                    "transcript_thread_path": "/tmp/transcripts/case-1",
                    "timeout_seconds": 30,
                    "runtime_context": {},
                }
                return await env.client.execute_workflow(
                    RepositoryCaseReviewWorkflow.run,
                    request,
                    id="repository-case-test",
                    task_queue="repository-case-test",
                )
    raise AssertionError("Temporal test worker exited before returning a result.")
