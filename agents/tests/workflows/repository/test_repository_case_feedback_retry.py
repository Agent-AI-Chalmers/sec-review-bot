from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from temporalio import activity
from temporalio.worker import Worker

from sec_review_agents.filesystem.backend_factory import BackendConfig
from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.cvss.result import (
    CvssStageResult,
    build_cvss_v4_stage_result,
)
from sec_review_agents.review_stages.feedback_loop import FeedbackRetryContext
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.workflows.repository_case import stage as case_workflow
from sec_review_agents.workflows.repository_case.input import (
    RepositoryCaseExecutionInput,
)
from sec_review_agents.workflows.repository_case.workflow import (
    RepositoryCaseReviewRequest,
    RepositoryCaseReviewWorkflow,
)
from sec_review_agents.workflows.review_intent import TEST_CHANGES_ALLOW
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.analysis_fixtures import analysis_fixture, narrative_fixture
from tests.temporal_test_utils import temporal_time_skipping_environment


def repository_case_execution_input(case_id: str) -> RepositoryCaseExecutionInput:
    return {
        "case_id": case_id,
        "review_input": f"Prepared {case_id} review input.",
        "workspace_snapshot_tar_path": "/tmp/workspace.snapshot.tar",
        "history_path": "/tmp/history",
        "scan_mode": "full",
        "incremental_window_path": None,
        "test_changes": TEST_CHANGES_ALLOW,
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


async def _mitigation_error_stage_result(tmp_path: Path) -> MitigationStageResult:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "app.py").write_text("print('hello')\n", encoding="utf-8")
    snapshot_tar = tmp_path / "workspace.snapshot.tar"
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=snapshot_tar)

    case_input = repository_case_execution_input("case-mitigation-error")
    case_input["workspace_snapshot_tar_path"] = str(snapshot_tar)
    case_input["history_path"] = str(tmp_path / "history")

    with (
        patch(
            "sec_review_agents.workflows.repository_case.mitigation.build_repository_mitigation_backend_config",
            return_value=BackendConfig(
                container_name_prefix="test",
                path_views=[],
                image=None,
                backend_kind="local",
            ),
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.run_mitigation_agent",
            side_effect=RuntimeError("mitigator exploded"),
        ),
    ):
        return await case_workflow.run_repository_case_mitigation_stage(
            case_input,
            analysis_fixture(
                verdict="confirmed-vulnerability",
                narratives=[narrative_fixture(verdict="confirmed-vulnerability")],
            ),
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

    case_input = repository_case_execution_input("case-verification-error")
    case_input["workspace_snapshot_tar_path"] = str(snapshot_tar)
    case_input["history_path"] = str(tmp_path / "history")

    with (
        patch(
            "sec_review_agents.workflows.repository_case.verification.build_repository_verification_backend_config",
            return_value=BackendConfig(
                container_name_prefix="test",
                path_views=[],
                image=None,
                backend_kind="local",
            ),
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage.run_verification_agent",
            side_effect=RuntimeError("verifier exploded"),
        ),
        pytest.raises(RuntimeError, match="verifier exploded"),
    ):
        await case_workflow.run_repository_case_verification_stage(
            case_input,
            analysis_fixture(verdict="confirmed-vulnerability", narratives=[]),
            MitigationStageResult(overview="Test mitigation"),
            None,
            None,
            verifier_artifacts_path=tmp_path / "verifier",
        )


@pytest.mark.asyncio
async def test_repository_case_without_patch_does_not_retry_verification() -> None:
    state = _CaseWorkflowState(
        mitigation_results=[
            MitigationStageResult(
                overview="Test mitigation",
                file_changes=[],
            )
        ],
        verification_results=[
            VerificationStageResult(
                patch_coverage="no-patch",
                resolution_next_step="manual-review",
                patch_findings=[],
                verification_findings=[],
                overview="Test verification",
                review_target_claim=None,
                validation_level=None,
                regression_status=None,
            )
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
            MitigationStageResult(
                overview="The first mitigation did not produce a patch.",
                file_changes=[],
            ),
            MitigationStageResult(
                overview="revised",
                file_changes=[
                    {"path": path, "status": "deleted"} for path in ["case-1.py"]
                ],
            ),
        ],
        verification_results=[
            VerificationStageResult(
                overview="Patch still needs revision.",
                review_target_claim="target claim",
                patch_coverage="partial",
                resolution_next_step="retry-ai",
                validation_level="static",
                patch_findings=["needs revision"],
                verification_findings=["first verifier"],
                residual_risks=[],
                regression_status=None,
            ),
            VerificationStageResult(
                overview="Patch fully covers the target claim.",
                review_target_claim="target claim",
                patch_coverage="full",
                resolution_next_step="none",
                validation_level="static",
                patch_findings=[],
                verification_findings=["second verifier"],
                residual_risks=[],
                regression_status=None,
            ),
        ],
    )

    result = await _run_case_workflow(state)

    assert len(state.mitigation_retry_contexts) == 2
    assert state.mitigation_retry_contexts[0] is None
    assert state.mitigation_retry_contexts[1] is not None
    assert state.mitigation_retry_contexts[1].retry_index == 1
    assert len(state.verification_retry_contexts) == 2
    assert state.verification_retry_contexts[0] is None
    assert state.verification_retry_contexts[1] is not None
    assert state.verification_retry_contexts[1].retry_index == 1
    assert len(state.archive_retry_contexts) == 1
    assert result["review_record"]["verification"]["patch_coverage"] == "full"
    assert result["disposition"] == "keep"
    assert "diagnostics" not in result


class _CaseWorkflowState:
    def __init__(
        self,
        *,
        mitigation_results: list[MitigationStageResult],
        verification_results: list[VerificationStageResult],
    ) -> None:
        self.mitigation_results = list(mitigation_results)
        self.verification_results = list(verification_results)
        self.mitigation_retry_contexts: list[FeedbackRetryContext | None] = []
        self.verification_retry_contexts: list[FeedbackRetryContext | None] = []
        self.archive_retry_contexts: list[FeedbackRetryContext] = []


async def _run_case_workflow(state: _CaseWorkflowState) -> dict[str, Any]:
    @activity.defn(name="prepare_repository_case_activity")
    def fake_prepare_repository_case(request: dict[str, Any]) -> dict[str, Any]:
        return {
            "case_execution_input": request["case_execution_input"],
            "published_trajectories_path": request["published_trajectories_path"],
            "artifact_paths": {
                "analyzer": "/tmp/cases/case-1/analyzer",
                "cvss": "/tmp/cases/case-1/cvss",
                "mitigator": "/tmp/cases/case-1/mitigator",
                "verifier": "/tmp/cases/case-1/verifier",
            },
        }

    @activity.defn(name="analyze_repository_case_activity")
    def fake_analyze_repository_case(
        _request: dict[str, Any],
        _prepared_case: dict[str, Any],
    ) -> AnalysisStageResult:
        return analysis_fixture(
            overview="confirmed",
            verdict="confirmed-vulnerability",
            narratives=[narrative_fixture(verdict="confirmed-vulnerability")],
        )

    @activity.defn(name="score_repository_case_cvss_activity")
    def fake_score_repository_case_cvss(
        _request: dict[str, Any],
        _prepared_case: dict[str, Any],
        _analysis_result: AnalysisStageResult,
    ) -> CvssStageResult:
        return build_cvss_v4_stage_result(
            outcome="scored", overview="Test scoring outcome"
        )

    @activity.defn(name="mitigate_repository_case_activity")
    def fake_mitigate_repository_case(
        _request: dict[str, Any],
        _prepared_case: dict[str, Any],
        _analysis_result: AnalysisStageResult,
        retry_context: FeedbackRetryContext | None,
    ) -> MitigationStageResult:
        state.mitigation_retry_contexts.append(retry_context)
        return state.mitigation_results.pop(0)

    @activity.defn(name="verify_repository_case_activity")
    def fake_verify_repository_case(
        _request: dict[str, Any],
        _prepared_case: dict[str, Any],
        _analysis_result: AnalysisStageResult,
        _mitigation_result: MitigationStageResult | None,
        retry_context: FeedbackRetryContext | None,
    ) -> VerificationStageResult:
        state.verification_retry_contexts.append(retry_context)
        if retry_context is not None:
            history = retry_context.history
            assert len(history) == 1
            assert history[0].patch_coverage == "partial"
            assert history[0].resolution_next_step == "retry-ai"
        return state.verification_results.pop(0)

    @activity.defn(name="archive_repository_case_feedback_attempt_activity")
    def fake_archive_repository_case_feedback_attempt(
        _prepared_case: dict[str, Any],
        retry_context: FeedbackRetryContext,
    ) -> None:
        state.archive_retry_contexts.append(retry_context)

    @activity.defn(name="build_repository_case_result_activity")
    def fake_build_repository_case_result(
        prepared_case: dict[str, Any],
        _analysis_result: AnalysisStageResult,
        cvss_result: CvssStageResult | None,
        mitigation_result: MitigationStageResult | None,
        verifier_result: VerificationStageResult | None,
    ) -> dict[str, Any]:
        return {
            "case_id": prepared_case["case_execution_input"]["case_id"],
            "disposition": (
                "keep"
                if verifier_result is not None
                and verifier_result.patch_coverage == "full"
                else "blocked"
            ),
            "review_record": {
                "cvss": (
                    cvss_result.model_dump(mode="json")
                    if cvss_result is not None
                    else None
                ),
                "mitigation": (
                    mitigation_result.model_dump(mode="json")
                    if mitigation_result is not None
                    else {}
                ),
                "verification": (
                    verifier_result.model_dump(mode="json")
                    if verifier_result is not None
                    else {}
                ),
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
                    "published_trajectories_path": "/tmp/cases/case-1/trajectories",
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
