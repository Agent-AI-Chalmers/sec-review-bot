import asyncio
from collections import defaultdict
from pathlib import Path
from typing import Literal

from sec_review_agents.agents.triage.agent import (
    run_repository_triage_agent as run_triage_agent,
)
from sec_review_agents.agents.triage.backend import (
    create_repository_triage_backend,
)
from sec_review_agents.agents.triage.prompts import (
    TriagePhase,
    build_repository_triage_user_prompt,
)
from sec_review_agents.agents.triage.workbench_state import TriageWorkbenchState
from sec_review_agents.observability.diagnostics import (
    log_stage_completed,
    log_stage_failed,
    log_stage_started,
)
from sec_review_agents.observability.trace_context import bind_trace_context
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.trajectories import remove_trajectories, trajectory_path
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryCandidateResult,
    DiscoveryResult,
)
from sec_review_agents.scan_stages.triage.batching import triage_candidate_batches
from sec_review_agents.scan_stages.triage.result import (
    TriageCounts,
    TriageMetadata,
    TriageResult,
)
from sec_review_agents.utils.bounded_map import map_bounded
from sec_review_agents.utils.files import persist_json_artifact

DEFAULT_TRIAGE_BATCH_SIZE = 30
TRIAGE_MAX_BATCH_CONCURRENCY = 3
TriageMode = Literal["single", "batched"]

TRIAGE_STAGE = "triage"
REPOSITORY_TRIAGER_AGENT_NAME = "repository-triager"


async def run_repository_triage_stage(
    *,
    triage_root: Path,
    discovery_result: DiscoveryResult,
    triage_mode: TriageMode = "single",
    max_batch_size: int = DEFAULT_TRIAGE_BATCH_SIZE,
) -> TriageResult:
    started_at = log_stage_started(
        stage=TRIAGE_STAGE,
        input_candidate_count=len(discovery_result.candidates),
    )
    # Triage is fail-fast: invalid agent output fails the stage instead of
    # emitting a completed artifact with notes.
    try:
        candidates = discovery_result.candidates

        if candidates:
            persist_json_artifact(
                triage_root,
                "triage-input",
                {
                    "summary": {
                        "candidate_count": len(candidates),
                    },
                    "candidates": [
                        {
                            **item.candidate.model_dump(mode="json", exclude_none=True),
                            "candidate_id": item.candidate_id,
                            "grounding_status": item.grounding_status,
                        }
                        for item in candidates
                    ],
                },
            )
            if triage_mode == "batched":
                workbench_state, agent_run_count = await _run_batched_triage(
                    triage_root=triage_root,
                    triage_candidates=candidates,
                    max_batch_size=max_batch_size,
                )
            else:
                workbench_state, agent_run_count = await _run_single_triage(
                    triage_root=triage_root,
                    triage_candidates=candidates,
                )

        else:
            workbench_state = TriageWorkbenchState.from_candidates([])
            agent_run_count = 0

        if not workbench_state.constraints()["ok"]:
            raise RuntimeError("triage workbench is incomplete after agent execution.")
        cases, suppressed_candidates = workbench_state.export_cases_and_suppressions()
        result = TriageResult(
            status="completed",
            metadata=TriageMetadata(
                triage_mode=triage_mode,
                agent_run_count=agent_run_count,
                batch_size=max_batch_size if triage_mode == "batched" else None,
            ),
            counts=TriageCounts(
                input_candidate_count=len(candidates),
                case_count=len(cases),
                suppressed_candidate_count=len(suppressed_candidates),
            ),
            cases=cases,
            suppressed_candidates=suppressed_candidates,
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


async def _run_single_triage(
    *,
    triage_root: Path,
    triage_candidates: list[DiscoveryCandidateResult],
) -> tuple[TriageWorkbenchState, int]:
    workbench_state = TriageWorkbenchState.from_candidates(triage_candidates)
    await _invoke_triage_agent(
        triage_root=triage_root,
        workbench_state=workbench_state,
        phase="draft",
    )
    await _invoke_triage_agent(
        triage_root=triage_root,
        workbench_state=workbench_state,
        phase="refinement",
    )
    return workbench_state, 2


async def _run_batched_triage(
    *,
    triage_root: Path,
    triage_candidates: list[DiscoveryCandidateResult],
    max_batch_size: int,
) -> tuple[TriageWorkbenchState, int]:
    global_state = TriageWorkbenchState.from_candidates(triage_candidates)
    draft_origins: list[dict] = []
    batches = triage_candidate_batches(triage_candidates, max_batch_size=max_batch_size)
    # Route candidates once, preserving their original order within each batch.
    batch_candidates: list[list[DiscoveryCandidateResult]] = [[] for _ in batches]
    batch_indices_by_candidate_id: dict[str, list[int]] = defaultdict(list)
    for index, candidate_ids in enumerate(batches):
        for candidate_id in set(candidate_ids):
            batch_indices_by_candidate_id[candidate_id].append(index)
    for candidate in triage_candidates:
        for index in batch_indices_by_candidate_id.get(
            candidate.candidate_id.strip(), []
        ):
            batch_candidates[index].append(candidate)

    # Batch drafts run concurrently, but each batch owns its own workbench state.
    # The shared global state is updated only below, in batch index order, so
    # async interleaving cannot reorder or race group creation.

    async def run_batch(index: int) -> list[dict]:
        return await _run_triage_batch_draft(
            triage_root=triage_root,
            batch_candidates=batch_candidates[index],
            batch_index=index + 1,
        )

    batch_results = await map_bounded(
        range(len(batch_candidates)),
        run_batch,
        max_concurrency=TRIAGE_MAX_BATCH_CONCURRENCY,
        wait=asyncio.wait,
    )

    for index, batch_group_drafts in enumerate(batch_results, start=1):
        if not batch_group_drafts:
            continue
        create_result = global_state.create_groups(groups=batch_group_drafts)
        created_group_ids = create_result.get("created_group_ids") or []
        if created_group_ids:
            draft_origins.append(
                {
                    "scope": f"draft batch {index:04d}",
                    "group_ids": list(created_group_ids),
                }
            )

    await _invoke_triage_agent(
        triage_root=triage_root,
        workbench_state=global_state,
        phase="refinement",
        draft_origins=draft_origins,
    )
    return global_state, len(batch_results) + 1


async def _run_triage_batch_draft(
    *,
    triage_root: Path,
    batch_candidates: list[DiscoveryCandidateResult],
    batch_index: int,
) -> list[dict]:
    batch_state = TriageWorkbenchState.from_candidates(batch_candidates)
    await _invoke_triage_agent(
        triage_root=triage_root,
        batch_index=batch_index,
        workbench_state=batch_state,
        phase="draft",
    )
    return batch_state.group_drafts()


async def _invoke_triage_agent(
    *,
    triage_root: Path,
    workbench_state: TriageWorkbenchState,
    phase: TriagePhase,
    draft_origins: list[dict] | None = None,
    batch_index: int | None = None,
) -> None:
    artifacts_path = _triage_artifacts_path(
        triage_root, phase=phase, batch_index=batch_index
    )
    remove_trajectories((trajectory_path(artifacts_path),))
    backend = create_repository_triage_backend()
    async with amanaged_backend(backend):
        # The activity-level context identifies the run. These local labels explain
        # why one triage stage can produce several otherwise identical invocations.
        with bind_trace_context(
            agent_phase=phase,
            batch_index=str(batch_index) if batch_index is not None else None,
        ):
            await run_triage_agent(
                backend=backend,
                workbench_state=workbench_state,
                phase=phase,
                user_prompt=build_repository_triage_user_prompt(
                    items=workbench_state.prompt_items(),
                    phase=phase,
                    draft_origins=draft_origins,
                ),
                trajectory_paths=(trajectory_path(artifacts_path),),
            )


def _triage_artifacts_path(
    triage_root: Path, *, phase: TriagePhase, batch_index: int | None = None
) -> Path:
    if phase == "refinement":
        return triage_root / "refinement"
    if batch_index is not None:
        return triage_root / "batches" / f"batch-{batch_index:04d}"
    return triage_root


__all__ = [
    "REPOSITORY_TRIAGER_AGENT_NAME",
    "TRIAGE_STAGE",
    "run_repository_triage_stage",
]
