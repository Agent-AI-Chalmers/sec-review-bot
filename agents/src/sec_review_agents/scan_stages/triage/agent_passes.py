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
    TriagePassKind,
    build_repository_triage_user_prompt,
)
from sec_review_agents.agents.triage.workbench_state import TriageWorkbenchState
from sec_review_agents.observability.trace_context import bind_trace_context
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.trajectories import remove_trajectories, trajectory_path
from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult
from sec_review_agents.scan_stages.triage.batching import triage_candidate_batches
from sec_review_agents.scan_stages.triage.result import (
    TriageCounts,
    TriageMetadata,
    TriageResult,
)
from sec_review_agents.utils.files import persist_json_artifact

DEFAULT_TRIAGE_PASSES = 2
DEFAULT_TRIAGE_BATCH_SIZE = 30
TRIAGE_MAX_BATCH_CONCURRENCY = 3
# Not exported today, but this names the triage mode contract rather than a
# private implementation detail.
TriageMode = Literal["single", "batched"]


def _triage_pass_artifacts_path(
    triage_root: Path, pass_meta: dict | None = None
) -> Path:
    pass_meta = pass_meta or {}
    if pass_meta.get("kind") == "batch":
        index = int(pass_meta.get("index") or 0)
        return triage_root / "batches" / f"batch-{index:04d}"
    if pass_meta.get("kind") == "refinement":
        return triage_root / "refinement"
    return triage_root


async def run_repository_triage_agent(
    *,
    triage_root: Path,
    triage_candidates: list[DiscoveryCandidateResult],
    max_passes: int = DEFAULT_TRIAGE_PASSES,
    triage_mode: TriageMode = "single",
    max_batch_size: int = DEFAULT_TRIAGE_BATCH_SIZE,
) -> TriageResult:
    """Run a draft phase and at most one refinement phase.

    ``max_passes <= 1`` disables refinement; larger values allow one refinement,
    conditional on draft edits in single mode and unconditional in batched mode.
    Batch drafts are separate invocations, not additional refinement phases.
    """
    persist_json_artifact(
        triage_root,
        "triage-input",
        {
            "summary": {
                "candidate_count": len(triage_candidates),
            },
            "candidates": [
                {
                    **item.candidate.model_dump(mode="json", exclude_none=True),
                    "candidate_id": item.candidate_id,
                    "grounding_status": item.grounding_status,
                }
                for item in triage_candidates
            ],
        },
    )
    if triage_mode == "batched":
        workbench_state, pass_count = await _run_batched_triage_passes(
            triage_root=triage_root,
            triage_candidates=triage_candidates,
            max_passes=max_passes,
            max_batch_size=max_batch_size,
        )
    else:
        workbench_state, pass_count = await _run_single_triage_passes(
            triage_root=triage_root,
            triage_candidates=triage_candidates,
            max_passes=max_passes,
        )

    if not workbench_state.constraints()["ok"]:
        raise RuntimeError("triage workbench is incomplete after agent execution.")
    cases, suppressed_candidates = workbench_state.export_cases_and_suppressions()
    return TriageResult(
        status="completed",
        metadata=TriageMetadata(
            triage_mode=triage_mode,
            triage_pass_count=pass_count,
            batch_size=max_batch_size if triage_mode == "batched" else None,
        ),
        counts=TriageCounts(
            input_candidate_count=len(triage_candidates),
            case_count=len(cases),
            suppressed_candidate_count=len(suppressed_candidates),
        ),
        cases=cases,
        suppressed_candidates=suppressed_candidates,
    )


async def _run_single_triage_passes(
    *,
    triage_root: Path,
    triage_candidates: list[DiscoveryCandidateResult],
    max_passes: int,
) -> tuple[TriageWorkbenchState, int]:
    workbench_state = TriageWorkbenchState.from_candidates(triage_candidates)
    edit_event_start = len(workbench_state.edit_events)
    await _run_repository_triage_agent_pass(
        triage_root=triage_root,
        workbench_state=workbench_state,
        pass_index=0,
    )
    # Inspect only the draft invocation's edits when deciding on refinement.
    if not _should_run_another_triage_pass(
        workbench_state=workbench_state,
        pass_index=0,
        max_passes=max_passes,
        pass_edit_events=workbench_state.edit_events[edit_event_start:],
    ):
        return workbench_state, 1

    await _run_repository_triage_agent_pass(
        triage_root=triage_root,
        pass_meta={"kind": "refinement"},
        workbench_state=workbench_state,
        pass_index=1,
    )
    return workbench_state, 2


async def _run_batched_triage_passes(
    *,
    triage_root: Path,
    triage_candidates: list[DiscoveryCandidateResult],
    max_passes: int,
    max_batch_size: int,
) -> tuple[TriageWorkbenchState, int]:
    global_state = TriageWorkbenchState.from_candidates(triage_candidates)
    pass_count = 0
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
    semaphore = asyncio.Semaphore(TRIAGE_MAX_BATCH_CONCURRENCY)

    async def run_batch(
        index: int,
        candidates: list[DiscoveryCandidateResult],
    ) -> tuple[int, list[dict]]:
        async with semaphore:
            batch_group_drafts = await _run_triage_batch_draft(
                triage_root=triage_root,
                batch_candidates=candidates,
                batch={
                    "kind": "batch",
                    "index": index,
                    "count": len(batches),
                    "max_batch_size": max_batch_size,
                },
            )
            return index, batch_group_drafts

    batch_results = await asyncio.gather(
        *(
            run_batch(index, candidates)
            for index, candidates in enumerate(batch_candidates, start=1)
        )
    )
    indexed_batch_results = dict(batch_results)
    pass_count += len(batch_results)

    for index in range(1, len(batches) + 1):
        batch_group_drafts = indexed_batch_results[index]
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

    if max_passes > 1:
        await _run_repository_triage_agent_pass(
            triage_root=triage_root,
            pass_meta={"kind": "refinement"},
            workbench_state=global_state,
            pass_index=1,
            draft_origins=draft_origins,
        )
        pass_count += 1
    return global_state, pass_count


async def _run_triage_batch_draft(
    *,
    triage_root: Path,
    batch_candidates: list[DiscoveryCandidateResult],
    batch: dict,
) -> list[dict]:
    batch_state = TriageWorkbenchState.from_candidates(batch_candidates)
    await _run_repository_triage_agent_pass(
        triage_root=triage_root,
        pass_meta=batch,
        workbench_state=batch_state,
        pass_index=0,
    )
    return batch_state.group_drafts()


async def _run_repository_triage_agent_pass(
    *,
    triage_root: Path,
    workbench_state: TriageWorkbenchState,
    pass_index: int,
    draft_origins: list[dict] | None = None,
    pass_meta: dict | None = None,
) -> None:
    pass_kind: TriagePassKind = "draft" if pass_index <= 0 else "refinement"
    batch_index = (
        str(pass_meta["index"])
        if pass_meta and pass_meta.get("kind") == "batch"
        else None
    )
    pass_artifacts_path = _triage_pass_artifacts_path(triage_root, pass_meta)
    remove_trajectories((trajectory_path(pass_artifacts_path),))
    backend = create_repository_triage_backend()
    async with amanaged_backend(backend):
        # The activity-level context identifies the run. These local labels explain
        # why one triage stage can produce several otherwise identical invocations.
        with bind_trace_context(
            pass_kind=pass_kind,
            pass_index=str(pass_index),
            batch_index=batch_index,
        ):
            await run_triage_agent(
                backend=backend,
                workbench_state=workbench_state,
                pass_kind=pass_kind,
                user_prompt=build_repository_triage_user_prompt(
                    items=workbench_state.prompt_items(),
                    pass_kind=pass_kind,
                    draft_origins=draft_origins,
                ),
                trajectory_paths=(trajectory_path(pass_artifacts_path),),
            )


def _should_run_another_triage_pass(
    *,
    workbench_state: TriageWorkbenchState,
    pass_index: int,
    max_passes: int,
    pass_edit_events: list[dict] | None = None,
) -> bool:
    """Allow one quality check for an incomplete or bulk-created single-mode draft."""
    if pass_index + 1 >= max(1, max_passes):
        return False
    if pass_index > 0:
        return False
    if not workbench_state.constraints().get("ok"):
        return True
    operations = [
        str(event.get("operation") or "")
        for event in (pass_edit_events or [])
        if isinstance(event, dict)
    ]
    # Bulk creation alone is a draft-only signal, not evidence of a quality audit.
    return operations in (["create_groups"], ["delete_groups", "create_groups"])


__all__ = [
    "run_repository_triage_agent",
]
