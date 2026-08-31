import asyncio
import contextlib
from typing import Any

from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.workflows.repository.workflow import (
    RepositoryCaseReviewRequest,
    _stage_error_message,
    analyze_repository_case_activity,
    archive_repository_case_feedback_attempt_activity,
    build_failed_repository_case_cvss_result_activity,
    build_repository_case_result_activity,
    mitigate_repository_case_activity,
    prepare_repository_case_activity,
    score_repository_case_cvss_activity,
    verify_repository_case_activity,
)


async def run_repository_case_review_direct(
    request: RepositoryCaseReviewRequest,
) -> dict[str, Any]:
    """Run one repository case review locally through activity functions."""
    # Local direct runs reuse activity functions for artifact parity, but they do
    # not emulate Temporal retries. Runtime failures must still propagate.
    prepared_case = prepare_repository_case_activity(request)
    runtime_context = request["runtime_context"]
    analysis_result = await analyze_repository_case_activity(
        prepared_case,
        runtime_context,
    )
    cvss_result_task = asyncio.create_task(
        score_repository_case_cvss_activity(
            prepared_case,
            analysis_result,
        )
    )
    try:
        mitigation_result = await mitigate_repository_case_activity(
            prepared_case,
            analysis_result,
            None,
            runtime_context,
        )
        verifier_result = await verify_repository_case_activity(
            prepared_case,
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
            archive_repository_case_feedback_attempt_activity(
                prepared_case,
                retry_context,
            )
            mitigation_result = await mitigate_repository_case_activity(
                prepared_case,
                analysis_result,
                retry_context,
                runtime_context,
            )
            verifier_result = await verify_repository_case_activity(
                prepared_case,
                analysis_result,
                mitigation_result,
                retry_context,
                runtime_context,
            )
        # Match the workflow path: CVSS scoring failures do not block
        # mitigation/verifier output, but public CVSS remains empty.
        cvss_result: dict[str, Any] | None
        try:
            cvss_result = await cvss_result_task
        except Exception as cvss_error:
            cvss_result = build_failed_repository_case_cvss_result_activity(
                prepared_case,
                _stage_error_message(cvss_error),
            )
    except Exception:
        cvss_result_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await cvss_result_task
        raise
    return build_repository_case_result_activity(
        prepared_case,
        analysis_result,
        cvss_result,
        mitigation_result,
        verifier_result,
    )


__all__ = [
    "run_repository_case_review_direct",
]
