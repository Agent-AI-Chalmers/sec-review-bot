from collections.abc import Mapping, Sequence
from typing import Any

from sec_review_agents.utils.structured_renderer import (
    render_structured_markdown,
    render_structured_markdown_section,
)

# One verifier-driven repair pass is the current production safety boundary. The
# history plumbing below is intentionally ready for higher limits, but changing
# this value should be treated as an agent-behavior change and re-probed.
MAX_FEEDBACK_RETRY_ATTEMPTS = 1
MAX_RETRY_HISTORY_PROMPT_ITEMS = 5


def should_retry_from_verifier_result(
    mitigation_result: Mapping[str, Any] | None,
    verifier_result: Mapping[str, Any] | None,
) -> bool:
    changed_files = (mitigation_result or {}).get("changed_files")
    if not (isinstance(changed_files, list) and changed_files):
        return False
    resolution_next_step = (
        str((verifier_result or {}).get("resolution_next_step") or "").strip().lower()
    )
    return resolution_next_step == "retry-ai"


def feedback_retry_context(
    *,
    retry_index: int,
    mitigation_result: Mapping[str, Any] | None,
    verifier_result: Mapping[str, Any] | None,
    history: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    summary = verifier_result_summary(verifier_result)
    # Preserve compact verifier feedback across retry rounds without carrying
    # full transcripts, diffs, or tool output back into prompts and artifacts.
    projected_history = [
        dict(item) for item in history or [] if isinstance(item, Mapping)
    ]
    if summary is not None:
        projected_history.append({"retry_index": retry_index, **summary})
    return {
        "retry_index": retry_index,
        "previous_mitigation_result": mitigation_result_summary(mitigation_result),
        "previous_verifier_result": summary,
        "history": projected_history,
    }


def mitigation_result_summary(
    mitigation_result: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(mitigation_result, Mapping):
        return None
    payload: dict[str, Any] = {
        "overview": mitigation_result.get("overview"),
    }
    if "changed_files" in mitigation_result:
        payload["changed_files"] = mitigation_result.get("changed_files") or []
    return payload


def verifier_result_summary(
    verifier_result: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(verifier_result, Mapping):
        return None
    return {
        "overview": verifier_result.get("overview"),
        "review_target_claim": verifier_result.get("review_target_claim"),
        "patch_coverage": verifier_result.get("patch_coverage"),
        "resolution_next_step": verifier_result.get("resolution_next_step"),
        "patch_findings": verifier_result.get("patch_findings") or [],
        "validation_level": verifier_result.get("validation_level"),
        "verification_findings": verifier_result.get("verification_findings") or [],
        "residual_risks": verifier_result.get("residual_risks") or [],
    }


def mitigation_feedback_retry_context(
    retry_context: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(retry_context, Mapping):
        return None

    history = retry_context.get("history")
    has_history = isinstance(history, list)
    previous_mitigation = mitigation_result_summary(
        retry_context.get("previous_mitigation_result")
    )
    latest_verifier = verifier_result_summary(
        retry_context.get("previous_verifier_result")
    )
    if previous_mitigation is None and latest_verifier is None and not has_history:
        return None

    result: dict[str, Any] = {}
    if previous_mitigation is not None:
        result["previous_mitigation"] = previous_mitigation
    if latest_verifier is not None:
        result["latest_verifier"] = latest_verifier
    if has_history:
        result["history"] = history
    return result


def verification_feedback_retry_context(
    retry_context: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(retry_context, Mapping):
        return None

    history = retry_context.get("history")
    has_history = isinstance(history, list)
    latest_verifier = verifier_result_summary(
        retry_context.get("previous_verifier_result")
    )
    if latest_verifier is None and not has_history:
        return None

    result: dict[str, Any] = {}
    if latest_verifier is not None:
        result["latest_verifier"] = latest_verifier
    if has_history:
        result["history"] = history
    return result


def render_history_projection_section(
    history: Sequence[Mapping[str, Any]] | None,
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
    feedback_retry: Mapping[str, Any] | None,
) -> str | None:
    if not isinstance(feedback_retry, Mapping):
        return None

    previous = feedback_retry.get("previous_mitigation")
    latest = feedback_retry.get("latest_verifier")
    history = feedback_retry.get("history")
    if (
        not isinstance(previous, Mapping)
        and not isinstance(latest, Mapping)
        and not isinstance(history, list)
    ):
        return None

    payload: dict[str, Any] = {}

    if isinstance(previous, Mapping):
        payload["previous_mitigation"] = {
            "overview": previous.get("overview"),
            "changed_files": previous.get("changed_files") or [],
        }

    latest_summary = verifier_result_summary(latest)
    if latest_summary is not None:
        payload["latest_verifier"] = dict(latest_summary)

    if isinstance(history, list) and history:
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
    history: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    projection: list[dict[str, Any]] = []
    for item in history:
        if not isinstance(item, Mapping):
            continue
        retry_index = item.get("retry_index")
        entry = {
            "title": f"Retry {retry_index}",
            "retry_index": retry_index,
            "patch_coverage": item.get("patch_coverage"),
            "patch_findings": item.get("patch_findings") or [],
        }
        projection.append(entry)
    return projection
