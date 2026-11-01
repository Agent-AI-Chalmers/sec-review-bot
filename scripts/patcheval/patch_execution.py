"""PatchEval's patch-ready boundary; production review delivery is unchanged."""

import hashlib
import json
import time
from pathlib import Path

from sec_review_agents.review_stages.feedback_loop import (
    MAX_FEEDBACK_RETRY_ATTEMPTS,
    feedback_retry_context,
    should_retry_from_verifier_result,
)
from sec_review_agents.workflows.issue.workflow import (
    analyze_issue_activity,
    archive_issue_feedback_attempt_activity,
    build_issue_review_result_activity,
    mitigate_issue_activity,
    verify_issue_activity,
)
from sec_review_agents.workflows.prepared_input import PreparedIssueInput
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest


def write_state(run: Path, state: dict) -> None:
    # Readers never see half a JSON document when a task is interrupted.
    pending = run / "patch-execution.json.tmp"
    pending.write_text(json.dumps(state, indent=2))
    pending.replace(run / "patch-execution.json")


def patch_ready(
    run: Path, patch: Path, attempt: str, state: dict, started: float
) -> None:
    state.update(
        phase="patch-ready",
        patch_path=str(patch.relative_to(run)),
        patch_sha256=(
            hashlib.sha256(patch.read_bytes()).hexdigest() if patch.is_file() else None
        ),
        patch_attempt=attempt,
        patch_ready_seconds=time.monotonic() - started,
    )
    write_state(run, state)


async def run_default(
    request: ReviewWorkflowRequest,
    run: Path,
    *,
    skip_final: bool,
    state: dict,
    started: float,
) -> dict:
    prepared = request.prepared_input
    assert isinstance(prepared, PreparedIssueInput)
    patch = Path(prepared.mitigator_artifacts_path) / "workspace.patch"
    state["phase"] = "analysis"
    write_state(run, state)
    analysis = await analyze_issue_activity(request)
    state["phase"] = "mitigation"
    write_state(run, state)
    mitigation = await mitigate_issue_activity(request, analysis, None)
    patch_ready(run, patch, "initial", state, started)
    verification = await verify_issue_activity(request, analysis, mitigation, None)
    history = []
    retry = 0
    while retry < MAX_FEEDBACK_RETRY_ATTEMPTS and should_retry_from_verifier_result(
        verification
    ):
        retry += 1
        context = feedback_retry_context(
            retry_index=retry,
            mitigation_result=mitigation,
            verifier_result=verification,
            history=history,
        )
        history = context.history
        archive_issue_feedback_attempt_activity(prepared, context)
        # The previous patch is no longer the selected final attempt once a
        # repair retry starts. A timeout here must not silently submit it.
        state.update(phase="mitigation", patch_sha256=None)
        write_state(run, state)
        mitigation = await mitigate_issue_activity(request, analysis, context)
        patch_ready(run, patch, f"retry-{retry}", state, started)
        if skip_final and retry == MAX_FEEDBACK_RETRY_ATTEMPTS:
            state["final_verifier_omitted"] = True
            # None truthfully means unverified; the earlier verdict applied to
            # another patch and must never be attached to this repair.
            verification = None
            break
        verification = await verify_issue_activity(
            request, analysis, mitigation, context
        )
    return build_issue_review_result_activity(analysis, mitigation, verification)
