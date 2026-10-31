import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from sec_review_agents.utils.files import json_artifact_path
from sec_review_agents.utils.structured_renderer import (
    render_structured_markdown,
    render_structured_markdown_section,
)
from sec_review_agents.workspace.file_changes import file_change_paths


class MitigationSummary(BaseModel):
    """Compact repair context; paths are retained but file contents and diffs are not.

    Built from a raw mitigation result once, then passed unchanged to retry
    consumers. It is not another mitigation stage result.
    """

    overview: str | None
    changed_files: list[str]


class VerifierSummary(BaseModel):
    """Corrective findings retained from one verifier result for the next attempt.

    Missing assessments remain None; empty finding lists mean no findings were
    provided. Full trajectories and execution output do not belong here.
    """

    overview: str | None
    review_target_claim: str | None
    patch_coverage: str | None
    resolution_next_step: str | None
    patch_findings: list[str]
    validation_level: str | None
    regression_status: str | None
    verification_findings: list[str]
    residual_risks: list[str]


class VerifierHistoryEntry(VerifierSummary):
    """A verifier summary tagged with the retry it prompted, in attempt order."""

    retry_index: int = Field(strict=True, gt=0)


class FeedbackRetryContext(BaseModel):
    """Prepared input to a bounded repair retry, shared by all review workflows.

    The builder validates the positive retry index and projects raw stage results.
    Consumers receive summaries, never raw mitigation or verification payloads;
    None at the call site denotes the initial attempt.
    """

    retry_index: int = Field(strict=True, gt=0)
    previous_mitigation_summary: MitigationSummary | None
    previous_verifier_summary: VerifierSummary | None
    history: list[VerifierHistoryEntry]


class VerificationRetryPromptContext(BaseModel):
    """Verifier-facing retry evidence, excluding the previous mitigation summary.

    The verifier receives the new mitigation separately, so this projection keeps
    only prior corrective findings and their history.
    """

    latest_verifier: VerifierSummary | None
    history: list[VerifierHistoryEntry]


class MitigationRetryPromptContext(VerificationRetryPromptContext):
    """Repair-facing retry evidence, including the preceding repair's summary."""

    previous_mitigation: MitigationSummary | None


# One verifier-driven repair pass is the current production safety boundary. The
# history plumbing below is intentionally ready for higher limits, but changing
# this value should be treated as an agent-behavior change and re-probed.
MAX_FEEDBACK_RETRY_ATTEMPTS = 1
MAX_RETRY_HISTORY_PROMPT_ITEMS = 5


def _copy_existing_artifact(source_path: Path, target_path: Path) -> None:
    if not source_path.exists():
        return
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_path, target_path)


def archive_initial_feedback_attempt(
    *,
    mitigator_root: Path,
    verifier_root: Path,
    retry_context: FeedbackRetryContext,
) -> None:
    """Keep initial feedback artifacts before the first retry overwrites them."""
    if retry_context.retry_index != 1:
        return

    _copy_existing_artifact(
        json_artifact_path(mitigator_root, "mitigation-result"),
        json_artifact_path(mitigator_root, "mitigation-result.initial"),
    )
    _copy_existing_artifact(
        mitigator_root / "workspace.patch",
        mitigator_root / "workspace.initial.patch",
    )

    _copy_existing_artifact(
        json_artifact_path(verifier_root, "verification-result"),
        json_artifact_path(verifier_root, "verification-result.initial"),
    )


def review_stage_attempt_order(
    *, stage: str, retry_context: FeedbackRetryContext | None
) -> int:
    """Return the ordered trajectory position for a review stage attempt."""
    if stage == "analyzer":
        return 1
    base = 2 if stage == "mitigator" else 3 if stage == "verifier" else None
    if base is None:
        raise ValueError(f"Unsupported review trajectory stage: {stage}")
    if retry_context is None:
        return base
    return base + (retry_context.retry_index * 2)


def should_retry_from_verifier_result(
    verifier_result: VerificationStageResult | None,
) -> bool:
    """Use the verifier's requested next step as the sole bounded-retry signal."""
    return (
        verifier_result is not None
        and verifier_result.resolution_next_step == "retry-ai"
    )


def feedback_retry_context(
    *,
    retry_index: int,
    mitigation_result: MitigationStageResult | None,
    verifier_result: VerificationStageResult | None,
    history: Sequence[VerifierHistoryEntry] | None = None,
) -> FeedbackRetryContext:
    if (
        isinstance(retry_index, bool)
        or not isinstance(retry_index, int)
        or retry_index < 1
    ):
        raise ValueError("retry_index must be a positive integer.")
    summary = verifier_result_summary(verifier_result)
    # Preserve compact verifier feedback across retry rounds without carrying
    # full trajectories, diffs, or tool output back into prompts and artifacts.
    projected_history = list(history or [])
    if summary is not None:
        projected_history.append(
            VerifierHistoryEntry(retry_index=retry_index, **summary.model_dump())
        )
    return FeedbackRetryContext(
        retry_index=retry_index,
        previous_mitigation_summary=mitigation_result_summary(mitigation_result),
        previous_verifier_summary=summary,
        history=projected_history,
    )


def mitigation_result_summary(
    mitigation_result: MitigationStageResult | None,
) -> MitigationSummary | None:
    if mitigation_result is None:
        return None
    return MitigationSummary(
        overview=mitigation_result.overview,
        changed_files=file_change_paths(mitigation_result.file_changes),
    )


def verifier_result_summary(
    verifier_result: VerificationStageResult | None,
) -> VerifierSummary | None:
    if verifier_result is None:
        return None
    return VerifierSummary(
        overview=verifier_result.overview,
        review_target_claim=verifier_result.review_target_claim,
        patch_coverage=verifier_result.patch_coverage,
        resolution_next_step=verifier_result.resolution_next_step,
        patch_findings=verifier_result.patch_findings or [],
        validation_level=verifier_result.validation_level,
        regression_status=verifier_result.regression_status,
        verification_findings=verifier_result.verification_findings or [],
        residual_risks=verifier_result.residual_risks or [],
    )


def mitigation_feedback_retry_context(
    retry_context: FeedbackRetryContext | None,
) -> MitigationRetryPromptContext | None:
    if retry_context is None:
        return None

    return MitigationRetryPromptContext(
        previous_mitigation=retry_context.previous_mitigation_summary,
        latest_verifier=retry_context.previous_verifier_summary,
        history=retry_context.history,
    )


def verification_feedback_retry_context(
    retry_context: FeedbackRetryContext | None,
) -> VerificationRetryPromptContext | None:
    if retry_context is None:
        return None
    return VerificationRetryPromptContext(
        latest_verifier=retry_context.previous_verifier_summary,
        history=retry_context.history,
    )


def render_history_projection_section(
    history: Sequence[VerifierHistoryEntry] | None,
) -> str | None:
    if not isinstance(history, Sequence) or not history:
        return None

    projection = _history_projection(history)
    if not projection:
        return None
    return render_structured_markdown_section(
        "Retry History Projection",
        {"items": projection},
        profile="prompt",
    )


def render_retry_revision_context_section(
    feedback_retry: MitigationRetryPromptContext | None,
) -> str | None:
    if feedback_retry is None:
        return None

    previous = feedback_retry.previous_mitigation
    latest = feedback_retry.latest_verifier
    history = feedback_retry.history
    payload: dict[str, Any] = {}
    if previous is not None:
        payload["previous_mitigation"] = previous.model_dump(mode="json")
    if latest is not None:
        payload["latest_verifier"] = latest.model_dump(mode="json")
    if history:
        # Keep the most recent corrective signal visible while bounding prompt
        # growth if the shared retry limit is raised.
        projections = _history_projection(history[-MAX_RETRY_HISTORY_PROMPT_ITEMS:])
        if projections:
            payload["verifier_history_snapshot"] = projections

    lines = render_structured_markdown(payload, profile="prompt")
    if not lines:
        return None
    return "\n".join(["# Retry Revision Context", "", *lines])


def _history_projection(
    history: Sequence[VerifierHistoryEntry],
) -> list[dict[str, Any]]:
    projection: list[dict[str, Any]] = []
    for item in history:
        retry_index = item.retry_index
        entry = {
            "title": f"Retry {retry_index}",
            "retry_index": retry_index,
            "patch_coverage": item.patch_coverage,
            "regression_status": item.regression_status,
            "resolution_next_step": item.resolution_next_step,
            "patch_findings": item.patch_findings or [],
        }
        projection.append(entry)
    return projection
