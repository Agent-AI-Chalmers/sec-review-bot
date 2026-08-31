from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

from sec_review_agents.observability.diagnostics import (
    log_stage_completed,
    log_stage_failed,
    log_stage_started,
)
from sec_review_agents.scan_stages.triage.result import (
    TriageCase,
    TriageMetadata,
    TriageResult,
)
from sec_review_agents.utils.files import persist_json

TRIAGE_STAGE = "triage"
REPOSITORY_TRIAGER_AGENT_NAME = "repository-triager"


def _triage_candidate_view(
    candidates: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    candidate_view = []
    for item in candidates:
        candidate_view.append(
            {
                "candidate_id": item["candidate_id"],
                "category": item.get("category"),
                "locations": item.get("locations") or [],
                "description": item.get("description"),
                "evidence": item.get("evidence") or [],
                "grounding_status": item.get("grounding_status"),
            }
        )
    return candidate_view


async def run_repository_triage_stage(
    *,
    triage_root: Path,
    discovery_result: Mapping[str, Any],
    triage_mode: Literal["single", "batched"] = "single",
    max_batch_size: int = 30,
) -> TriageResult:
    started_at = log_stage_started(
        stage=TRIAGE_STAGE,
        input_candidate_count=len(discovery_result.get("candidates") or []),
    )
    # Triage is fail-fast: invalid agent output fails the stage instead of
    # emitting a completed artifact with notes.
    try:
        from sec_review_agents.scan_stages.triage.agent_passes import (
            run_repository_triage_agent,
        )

        candidates = [
            item
            for item in discovery_result.get("candidates") or []
            if isinstance(item, dict)
        ]

        if candidates:
            agent_result = await run_repository_triage_agent(
                triage_root=triage_root,
                triage_candidates=_triage_candidate_view(candidates),
                triage_mode=triage_mode,
                max_batch_size=max_batch_size,
            )
            cases: list[TriageCase] = agent_result["cases"]
            suppressed_candidates = agent_result["suppressed_candidates"]
            cases.sort(key=lambda item: item["case_id"])
        else:
            cases, suppressed_candidates, agent_result = [], [], {}

        if agent_result:
            metadata: TriageMetadata = agent_result["metadata"]
        else:
            metadata = {
                "triage_mode": triage_mode,
                "triage_pass_count": 0,
                "batch_size": max_batch_size if triage_mode == "batched" else None,
            }
        result: TriageResult = {
            "status": "completed",
            "metadata": metadata,
            "counts": {
                "input_candidate_count": len(discovery_result.get("candidates") or []),
                "case_count": len(cases),
                "suppressed_candidate_count": len(suppressed_candidates),
            },
            "cases": cases,
            "suppressed_candidates": suppressed_candidates,
        }
        persist_json(
            triage_root,
            "triage-result.json",
            result,
        )
        log_stage_completed(
            stage=TRIAGE_STAGE,
            started_at=started_at,
            triage_mode=triage_mode,
            case_count=len(result["cases"]),
            suppressed_candidate_count=len(result["suppressed_candidates"]),
        )
        return result
    except Exception as error:
        log_stage_failed(
            stage=TRIAGE_STAGE,
            started_at=started_at,
            error=error,
        )
        raise


__all__ = [
    "REPOSITORY_TRIAGER_AGENT_NAME",
    "TRIAGE_STAGE",
    "run_repository_triage_stage",
]
