from pathlib import Path
from typing import Literal

from sec_review_agents.observability.diagnostics import (
    log_stage_completed,
    log_stage_failed,
    log_stage_started,
)
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryResult,
)
from sec_review_agents.scan_stages.triage.result import (
    TriageCounts,
    TriageMetadata,
    TriageResult,
)
from sec_review_agents.utils.files import persist_json_artifact

TRIAGE_STAGE = "triage"
REPOSITORY_TRIAGER_AGENT_NAME = "repository-triager"


async def run_repository_triage_stage(
    *,
    triage_root: Path,
    discovery_result: DiscoveryResult,
    triage_mode: Literal["single", "batched"] = "single",
    max_batch_size: int = 30,
) -> TriageResult:
    started_at = log_stage_started(
        stage=TRIAGE_STAGE,
        input_candidate_count=len(discovery_result.candidates),
    )
    # Triage is fail-fast: invalid agent output fails the stage instead of
    # emitting a completed artifact with notes.
    try:
        from sec_review_agents.scan_stages.triage.agent_passes import (
            run_repository_triage_agent,
        )

        candidates = discovery_result.candidates

        if candidates:
            result = await run_repository_triage_agent(
                triage_root=triage_root,
                triage_candidates=candidates,
                triage_mode=triage_mode,
                max_batch_size=max_batch_size,
            )
        else:
            result = TriageResult(
                status="completed",
                metadata=TriageMetadata(
                    triage_mode=triage_mode,
                    triage_pass_count=0,
                    batch_size=max_batch_size if triage_mode == "batched" else None,
                ),
                counts=TriageCounts(
                    input_candidate_count=0, case_count=0, suppressed_candidate_count=0
                ),
                cases=[],
                suppressed_candidates=[],
            )
        artifact = result.model_dump(mode="json")
        artifact["cases"] = [
            case.model_dump(mode="json", exclude_none=True) for case in result.cases
        ]
        persist_json_artifact(
            triage_root,
            "triage-result",
            artifact,
        )
        log_stage_completed(
            stage=TRIAGE_STAGE,
            started_at=started_at,
            triage_mode=triage_mode,
            case_count=len(result.cases),
            suppressed_candidate_count=len(result.suppressed_candidates),
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
