from typing import Any

from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.temporal.support import prepare_internal_workflow_activity
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.issue.workflow import (
    analyze_issue_activity,
    archive_issue_feedback_attempt_activity,
    build_issue_review_result_activity,
    mitigate_issue_activity,
    verify_issue_activity,
)


async def run_issue_review_direct(request: InternalWorkflowRequest) -> dict[str, Any]:
    prepare_internal_workflow_activity(request.workflow, request.run_id)
    prepared_input = request.prepared_input
    runtime_context = request.runtime_context
    analysis_result = await analyze_issue_activity(prepared_input, runtime_context)
    mitigation_result = await mitigate_issue_activity(
        prepared_input,
        analysis_result,
        None,
        runtime_context,
    )
    verifier_result = await verify_issue_activity(
        prepared_input,
        analysis_result,
        mitigation_result,
        None,
        runtime_context,
    )
    retry_count = 0
    history: list[dict[str, Any]] = []
    while (
        retry_count < MAX_FEEDBACK_RETRY_ATTEMPTS
        and should_retry_from_verifier_result(mitigation_result, verifier_result)
    ):
        retry_count += 1
        retry_context = feedback_retry_context(
            retry_index=retry_count,
            mitigation_result=mitigation_result,
            verifier_result=verifier_result,
            history=history,
        )
        history = retry_context["history"]
        archive_issue_feedback_attempt_activity(prepared_input, retry_context)
        mitigation_result = await mitigate_issue_activity(
            prepared_input,
            analysis_result,
            retry_context,
            runtime_context,
        )
        verifier_result = await verify_issue_activity(
            prepared_input,
            analysis_result,
            mitigation_result,
            retry_context,
            runtime_context,
        )
    return build_issue_review_result_activity(
        analysis_result,
        mitigation_result,
        verifier_result,
    )


__all__ = ["run_issue_review_direct"]
