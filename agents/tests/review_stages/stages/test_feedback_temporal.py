import asyncio
from datetime import timedelta

import pytest
from pydantic import ValidationError
from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from sec_review_agents.review_stages.feedback_loop import (
    FeedbackRetryContext,
    MitigationRetryPromptContext,
    feedback_retry_context,
    mitigation_feedback_retry_context,
)
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from tests.temporal_test_utils import temporal_time_skipping_environment


@activity.defn
async def project_retry_summary(
    context: FeedbackRetryContext,
) -> MitigationRetryPromptContext:
    projected = mitigation_feedback_retry_context(context)
    assert projected is not None
    return projected


@workflow.defn
class RetrySummaryProbe:
    @workflow.run
    async def run(self, context: FeedbackRetryContext) -> MitigationRetryPromptContext:
        return await workflow.execute_activity(
            project_retry_summary,
            context,
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=1),
        )


@pytest.mark.asyncio
async def test_retry_summary_survives_temporal_and_preserves_changed_paths() -> None:
    context = feedback_retry_context(
        retry_index=1,
        mitigation_result=MitigationStageResult(
            overview="Patched",
            file_changes=[
                {
                    "path": "guard.py",
                    "content": "not carried",
                    "status": "upsert",
                    "content_encoding": "utf-8",
                }
            ],
        ),
        verifier_result=VerificationStageResult(
            overview="Missing check",
            patch_findings=["gap"],
            review_target_claim=None,
            patch_coverage=None,
            resolution_next_step="none",
            validation_level=None,
            regression_status=None,
        ),
    )
    async with (
        temporal_time_skipping_environment() as env,
        Worker(
            env.client,
            task_queue="retry-summary",
            workflows=[RetrySummaryProbe],
            activities=[project_retry_summary],
        ),
    ):
        projected = await asyncio.wait_for(
            env.client.execute_workflow(
                RetrySummaryProbe.run,
                context,
                id="retry-summary",
                task_queue="retry-summary",
            ),
            timeout=30,
        )
    assert projected.previous_mitigation is not None
    assert projected.previous_mitigation.model_dump() == {
        "overview": "Patched",
        "changed_files": ["guard.py"],
    }
    assert projected.latest_verifier == context.previous_verifier_summary
    assert projected.history == context.history
    malformed = {**context.model_dump(), "retry_index": "1"}
    with pytest.raises(ValidationError, match="retry_index"):
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([malformed]), [FeedbackRetryContext]
        )


@pytest.mark.parametrize("retry_index", [0, -1, True])
def test_retry_builder_rejects_invalid_attempt_index(retry_index: int) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        feedback_retry_context(
            retry_index=retry_index, mitigation_result=None, verifier_result=None
        )
