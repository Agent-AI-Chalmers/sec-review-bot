"""Reusable CVSS scoring stage runtime; workflows own review-specific prompts."""

import tempfile
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import cvss  # type: ignore[import-untyped]

from sec_review_agents.agents.cvss.agent import create_cvss_agent_graph
from sec_review_agents.agents.cvss.model import (
    CVSS_VECTOR_ORDER,
    CvssV4ScoringOutput,
)
from sec_review_agents.review_stages.cvss.result import (
    CvssStageResult,
    build_cvss_v4_stage_result,
    build_failed_cvss_v4_result,
)
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.utils.files import persist_json
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar

CVSS_V4_SCORING_STAGE = "cvss-v4-scoring"


def persist_cvss_stage_result(
    *,
    cvss_artifacts_path: Path,
    result: Mapping[str, Any],
) -> None:
    persist_json(
        cvss_artifacts_path,
        "cvss-v4-result.json",
        result,
    )


def _build_metric_details(structured_payload: dict) -> dict[str, dict[str, str]]:
    rationale_by_metric = {
        str(item.get("metric")): str(item.get("rationale") or "").strip()
        for item in structured_payload.get("metric_rationales") or []
    }

    details: dict[str, dict[str, str]] = {}
    for metric in CVSS_VECTOR_ORDER:
        details[metric] = {
            "value": str(structured_payload.get(metric) or "").strip(),
            "rationale": rationale_by_metric.get(metric, ""),
        }
    return details


def _build_cvss_v4_vector(structured_payload: dict) -> str:
    parts = ["CVSS:4.0"]
    for metric in CVSS_VECTOR_ORDER:
        parts.append(f"{metric}:{structured_payload[metric]}")
    return "/".join(parts)


def _compute_cvss_v4_base(vector: str) -> tuple[str, float, str]:
    parsed = cvss.CVSS4(vector)
    base_score = parsed.base_score
    if base_score is None:
        raise ValueError(f"CVSS v4 vector did not produce a base score: {vector}")
    score = round(float(base_score), 1)
    severity = str(
        getattr(
            parsed,
            "severity",
            parsed.severities()[0] if parsed.severities() else "Unknown",
        )
    )
    severity_value = severity.strip().lower()

    if severity_value not in {"none", "low", "medium", "high", "critical"}:
        severity_value = "unknown"

    return str(parsed.clean_vector()), score, severity_value


def persist_failed_cvss_v4_result(
    *,
    cvss_artifacts_path: Path,
    error: str,
) -> None:
    persist_cvss_stage_result(
        cvss_artifacts_path=cvss_artifacts_path,
        result=build_failed_cvss_v4_result(error=error),
    )


def is_cvss_v4_scoring_target(analysis_result: Mapping[str, Any] | None) -> bool:
    verdict = str((analysis_result or {}).get("verdict") or "").strip()
    if verdict != "confirmed-vulnerability":
        return False

    narratives = (analysis_result or {}).get("narratives")
    if not isinstance(narratives, list):
        return False

    return any(
        isinstance(narrative, dict)
        and narrative.get("verdict") == "confirmed-vulnerability"
        for narrative in narratives
    )


async def run_cvss_v4_scoring_stage(
    *,
    cvss_artifacts_path: Path,
    agent_name: str,
    baseline_snapshot_tar_path: Path,
    build_backend: Callable[[Path], Any],
    system_prompt: str,
    filesystem_system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="sec-review-cvss-") as tempdir:
        reset_cvss_artifacts(cvss_artifacts_path=cvss_artifacts_path)
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        transcript_path = cvss_artifacts_path / "transcript.json"
        backend = build_backend(workspace_path)
        async with amanaged_backend(backend):
            agent = await create_cvss_agent_graph(
                agent_name=agent_name,
                backend=backend,
                system_prompt=system_prompt,
                filesystem_system_prompt=filesystem_system_prompt,
            )
            agent_output = await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=agent_name,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                transcript_paths=(transcript_path,),
            )
        result = build_cvss_stage_result_from_agent_output(agent_output)
        persist_cvss_stage_result(
            cvss_artifacts_path=cvss_artifacts_path, result=result
        )
        return result


def reset_cvss_artifacts(*, cvss_artifacts_path: Path) -> None:
    reset_stage_attempt_artifacts(
        cvss_artifacts_path,
        filenames=("cvss-v4-result.json", "transcript.json"),
    )


def build_cvss_stage_result_from_agent_output(
    agent_output: dict[str, Any],
) -> dict[str, Any]:
    if agent_output.get("scoring_status") == "not-scored":
        reason = str(agent_output.get("not_scored_reason") or "").strip()
        return build_cvss_v4_stage_result(
            outcome="not-scored",
            overview=agent_output["overview"],
            metrics={},
            not_scored_reason=reason,
        )

    vector = _build_cvss_v4_vector(agent_output)
    clean_vector, score, severity = _compute_cvss_v4_base(vector)

    return build_cvss_v4_stage_result(
        outcome="scored",
        overview=agent_output["overview"],
        version="4.0",
        vector=clean_vector,
        base_score=score,
        severity=severity,
        metrics=_build_metric_details(agent_output),
    )


__all__ = [
    "CVSS_V4_SCORING_STAGE",
    "CVSS_VECTOR_ORDER",
    "CvssStageResult",
    "CvssV4ScoringOutput",
    "build_cvss_stage_result_from_agent_output",
    "is_cvss_v4_scoring_target",
    "persist_cvss_stage_result",
    "persist_failed_cvss_v4_result",
    "run_cvss_v4_scoring_stage",
]
