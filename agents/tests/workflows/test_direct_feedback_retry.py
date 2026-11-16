from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sec_review_agents.review_stages.analysis.result import AnalysisStageResult
from sec_review_agents.review_stages.feedback_loop import FeedbackRetryContext
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.types import NextStep
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.utils.files import json_artifact_path
from sec_review_agents.workflows.issue import direct as issue_direct
from sec_review_agents.workflows.pull_request import direct as pr_direct
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from tests.analysis_fixtures import analysis_fixture
from tests.prepared_input_fixtures import (
    prepared_issue_input,
    prepared_pull_request_input,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["issue", "pull_request"])
@pytest.mark.parametrize("final_next_step", ["none", "retry-ai"])
async def test_direct_feedback_retry_preserves_initial_artifacts_and_latest_result(
    tmp_path: Path, scope: str, final_next_step: NextStep
) -> None:
    """A retry overwrites stage outputs, but must retain the original evidence and stop at budget."""
    module = issue_direct if scope == "issue" else pr_direct
    prepared = (
        prepared_issue_input if scope == "issue" else prepared_pull_request_input
    )(
        artifact_root_path=str(tmp_path),
        mitigator_artifacts_path=str(tmp_path / "mitigator"),
        verifier_artifacts_path=str(tmp_path / "verifier"),
    )
    request = ReviewWorkflowRequest(
        workflow="issue-review" if scope == "issue" else "pull-request-review",
        run_id="feedback-retry",
        prepared_input=prepared,
        timeout_seconds=30,
        runtime_context={},
    )
    analysis = analysis_fixture(verdict="no-actionable-finding", narratives=[])
    contexts: list[FeedbackRetryContext | None] = []
    events: list[str] = []
    mitigation_root = Path(prepared.mitigator_artifacts_path)
    verifier_root = Path(prepared.verifier_artifacts_path)
    mitigation_root.mkdir()
    verifier_root.mkdir()

    async def mitigate(
        _request: ReviewWorkflowRequest,
        _analysis: AnalysisStageResult,
        context: FeedbackRetryContext | None,
    ) -> MitigationStageResult:
        index = len(contexts)
        events.append(f"mitigate-{index}")
        contexts.append(context)
        if index == 1:
            assert context is not None
            assert context.retry_index == 1
            assert context.previous_mitigation_summary is not None
            assert context.previous_verifier_summary is not None
            assert context.previous_mitigation_summary.overview == "mitigation-0"
            assert context.previous_verifier_summary.next_step == "retry-ai"
            assert len(context.history) == 1
            assert (
                json_artifact_path(
                    mitigation_root, "mitigation-result.initial"
                ).read_text()
                == "initial mitigation"
            )
            assert (
                mitigation_root / "workspace.initial.patch"
            ).read_text() == "initial patch"
            assert (
                json_artifact_path(
                    verifier_root, "verification-result.initial"
                ).read_text()
                == "initial verification"
            )
        json_artifact_path(mitigation_root, "mitigation-result").write_text(
            "initial mitigation" if index == 0 else "revised mitigation"
        )
        (mitigation_root / "workspace.patch").write_text(
            "initial patch" if index == 0 else "revised patch"
        )
        return MitigationStageResult(
            overview=f"mitigation-{index}", file_changes=[], patch_diff=""
        )

    async def verify(
        _request: ReviewWorkflowRequest,
        _analysis: AnalysisStageResult,
        mitigation: MitigationStageResult,
        context: FeedbackRetryContext | None,
    ) -> VerificationStageResult:
        index = len(contexts) - 1
        events.append(f"verify-{index}")
        assert context is contexts[-1]
        assert mitigation.overview == f"mitigation-{index}"
        json_artifact_path(verifier_root, "verification-result").write_text(
            "initial verification" if index == 0 else "revised verification"
        )
        return VerificationStageResult(
            overview=f"verification-{index}",
            target_claim=None,
            coverage="full",
            next_step="retry-ai" if index == 0 else final_next_step,
            validation_level="static",
            regression="passed",
        )

    with (
        patch.object(
            module, f"analyze_{scope}_activity", new=AsyncMock(return_value=analysis)
        ),
        patch.object(module, f"mitigate_{scope}_activity", new=mitigate),
        patch.object(module, f"verify_{scope}_activity", new=verify),
    ):
        result = await (
            issue_direct.run_issue_review_direct(request)
            if scope == "issue"
            else pr_direct.run_pull_request_review_direct(request)
        )

    assert contexts[0] is None
    assert events == ["mitigate-0", "verify-0", "mitigate-1", "verify-1"]
    assert result["review_record"]["mitigation"]["overview"] == "mitigation-1"
    assert result["review_record"]["verification"]["overview"] == "verification-1"
    assert result["review_record"]["verification"]["next_step"] == final_next_step
