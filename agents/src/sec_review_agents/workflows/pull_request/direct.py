from typing import Any

from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    VerifierHistoryEntry,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.workflows.prepared_input import PreparedPullRequestInput
from sec_review_agents.workflows.pull_request.workflow import (
    analyze_pull_request_activity,
    archive_pull_request_feedback_attempt_activity,
    build_pull_request_review_result_activity,
    mitigate_pull_request_activity,
    verify_pull_request_activity,
)
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest


async def run_pull_request_review_direct(
    request: ReviewWorkflowRequest,
) -> dict[str, Any]:
    prepared_input = request.prepared_input
    assert isinstance(prepared_input, PreparedPullRequestInput)
    analysis_result = await analyze_pull_request_activity(request)
    mitigation_result = await mitigate_pull_request_activity(
        request,
        analysis_result,
        None,
    )
    verifier_result = await verify_pull_request_activity(
        request,
        analysis_result,
        mitigation_result,
        None,
    )
    retry_count = 0
    history: list[VerifierHistoryEntry] = []
    while (
        retry_count < MAX_FEEDBACK_RETRY_ATTEMPTS
        and should_retry_from_verifier_result(verifier_result)
    ):
        retry_count += 1
        retry_context = feedback_retry_context(
            retry_index=retry_count,
            mitigation_result=mitigation_result,
            verifier_result=verifier_result,
            history=history,
        )
        history = retry_context.history
        archive_pull_request_feedback_attempt_activity(prepared_input, retry_context)
        mitigation_result = await mitigate_pull_request_activity(
            request,
            analysis_result,
            retry_context,
        )
        verifier_result = await verify_pull_request_activity(
            request,
            analysis_result,
            mitigation_result,
            retry_context,
        )
    return build_pull_request_review_result_activity(
        analysis_result,
        mitigation_result,
        verifier_result,
    )


__all__ = ["run_pull_request_review_direct"]
