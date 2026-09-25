import asyncio
from pathlib import Path
from typing import Any, Literal

from sec_review_agents.agents.triage.agent import (
    REPOSITORY_TRIAGER_AGENT_NAME,
    create_repository_triage_agent_graph,
)
from sec_review_agents.agents.triage.backend import (
    create_repository_triage_backend,
)
from sec_review_agents.agents.triage.prompts import (
    TriagePassKind,
    build_repository_triage_system_prompt,
    build_repository_triage_user_prompt,
)
from sec_review_agents.agents.triage.workbench_state import TriageWorkbenchState
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import managed_backend
from sec_review_agents.scan_stages.triage.batching import triage_candidate_batches
from sec_review_agents.utils.files import persist_json

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
    triage_candidates: list[dict[str, Any]],
    max_passes: int = DEFAULT_TRIAGE_PASSES,
    triage_mode: TriageMode = "single",
    max_batch_size: int = DEFAULT_TRIAGE_BATCH_SIZE,
) -> dict:
    persist_json(
        triage_root,
        "triage-input.json",
        {
            "summary": {
                "candidate_count": len(triage_candidates),
            },
            "candidates": triage_candidates,
        },
    )
    if triage_mode == "batched":
        workbench_state, agent_results = await _run_batched_triage_passes(
            triage_root=triage_root,
            triage_candidates=triage_candidates,
            max_passes=max_passes,
            max_batch_size=max_batch_size,
        )
    else:
        workbench_state, agent_results = await _run_single_triage_passes(
            triage_root=triage_root,
            triage_candidates=triage_candidates,
            max_passes=max_passes,
        )

    finish_result = workbench_state.finish()
    if not finish_result["ok"]:
        raise RuntimeError("triage workbench is incomplete after agent execution.")
    result = {
        "agent_result": agent_results[-1] if agent_results else None,
        "agent_results": agent_results,
        "cases": finish_result["cases"],
        "suppressed_candidates": finish_result["suppressed_candidates"],
        "constraints": finish_result["constraints"],
        "metadata": {
            "triage_mode": triage_mode,
            "triage_pass_count": len(agent_results),
            "batch_size": max_batch_size if triage_mode == "batched" else None,
        },
    }
    return result


async def _run_single_triage_passes(
    *,
    triage_root: Path,
    triage_candidates: list[dict[str, Any]],
    max_passes: int,
) -> tuple[TriageWorkbenchState, list[dict | None]]:
    workbench_state = TriageWorkbenchState.from_candidates(triage_candidates)
    agent_results: list[dict | None] = []
    for pass_index in range(max(1, max_passes)):
        edit_event_start = len(workbench_state.edit_events)
        agent_results.append(
            await _run_repository_triage_agent_pass(
                triage_root=triage_root,
                pass_meta={"kind": "refinement"} if pass_index > 0 else None,
                workbench_state=workbench_state,
                pass_index=pass_index,
            )
        )
        if not _should_run_another_triage_pass(
            workbench_state=workbench_state,
            pass_index=pass_index,
            max_passes=max_passes,
            pass_edit_events=workbench_state.edit_events[edit_event_start:],
        ):
            break
    return workbench_state, agent_results


async def _run_batched_triage_passes(
    *,
    triage_root: Path,
    triage_candidates: list[dict[str, Any]],
    max_passes: int,
    max_batch_size: int,
) -> tuple[TriageWorkbenchState, list[dict | None]]:
    global_state = TriageWorkbenchState.from_candidates(triage_candidates)
    agent_results: list[dict | None] = []
    draft_origins: list[dict] = []
    batches = triage_candidate_batches(triage_candidates, max_batch_size=max_batch_size)
    batch_concurrency = min(
        max(1, len(batches)),
        TRIAGE_MAX_BATCH_CONCURRENCY,
    )

    # Batch drafts run concurrently, but each batch owns its own workbench state.
    # The shared global state is updated only below, in batch index order, so
    # async interleaving cannot reorder or race group creation.
    semaphore = asyncio.Semaphore(batch_concurrency)

    async def run_batch(
        index: int,
        batch_candidate_ids: list[str],
    ) -> tuple[int, dict | None, list[dict]]:
        async with semaphore:
            agent_result, batch_group_drafts = await _run_triage_batch_draft(
                triage_root=triage_root,
                triage_candidates=triage_candidates,
                batch_candidate_ids=batch_candidate_ids,
                batch={
                    "kind": "batch",
                    "index": index,
                    "count": len(batches),
                    "max_batch_size": max_batch_size,
                },
            )
            return index, agent_result, batch_group_drafts

    batch_results = await asyncio.gather(
        *(
            run_batch(index, batch_candidate_ids)
            for index, batch_candidate_ids in enumerate(batches, start=1)
        )
    )
    indexed_batch_results = {
        index: (agent_result, batch_group_drafts)
        for index, agent_result, batch_group_drafts in batch_results
    }

    for index in range(1, len(batches) + 1):
        agent_result, batch_group_drafts = indexed_batch_results[index]
        agent_results.append(agent_result)
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

    for pass_index in range(1, max(1, max_passes)):
        edit_event_start = len(global_state.edit_events)
        agent_results.append(
            await _run_repository_triage_agent_pass(
                triage_root=triage_root,
                pass_meta={"kind": "refinement"},
                workbench_state=global_state,
                pass_index=pass_index,
                draft_origins=draft_origins,
            )
        )
        if not _should_run_another_triage_pass(
            workbench_state=global_state,
            pass_index=pass_index,
            max_passes=max_passes,
            pass_edit_events=global_state.edit_events[edit_event_start:],
        ):
            break
    return global_state, agent_results


async def _run_triage_batch_draft(
    *,
    triage_root: Path,
    triage_candidates: list[dict[str, Any]],
    batch_candidate_ids: list[str],
    batch: dict,
) -> tuple[dict | None, list[dict]]:
    requested_candidate_ids = {
        str(candidate_id or "").strip()
        for candidate_id in batch_candidate_ids
        if str(candidate_id or "").strip()
    }
    batch_candidates = [
        dict(candidate)
        for candidate in triage_candidates
        if str(candidate.get("candidate_id") or "").strip() in requested_candidate_ids
    ]
    batch_state = TriageWorkbenchState.from_candidates(batch_candidates)
    agent_result = await _run_repository_triage_agent_pass(
        triage_root=triage_root,
        pass_meta=batch,
        workbench_state=batch_state,
        pass_index=0,
    )
    return agent_result, batch_state.group_drafts()


async def _run_repository_triage_agent_pass(
    *,
    triage_root: Path,
    workbench_state: TriageWorkbenchState,
    pass_index: int,
    draft_origins: list[dict] | None = None,
    pass_meta: dict | None = None,
) -> dict | None:
    pass_kind: TriagePassKind = "draft" if pass_index <= 0 else "refinement"
    reset_stage_attempt_artifacts(
        _triage_pass_artifacts_path(triage_root, pass_meta),
        filenames=("transcript.json",),
    )
    backend = create_repository_triage_backend()
    pass_artifacts_path = _triage_pass_artifacts_path(triage_root, pass_meta)
    with managed_backend(backend):
        agent = await create_repository_triage_agent_graph(
            backend=backend,
            workbench_state=workbench_state,
            pass_kind=pass_kind,
        )
        return await invoke_agent_runtime_graph(
            agent=agent,
            agent_name=REPOSITORY_TRIAGER_AGENT_NAME,
            system_prompt=build_repository_triage_system_prompt(pass_kind=pass_kind),
            user_prompt=build_repository_triage_user_prompt(
                items=workbench_state.prompt_items(),
                pass_kind=pass_kind,
                draft_origins=draft_origins,
            ),
            transcript_paths=(pass_artifacts_path / "transcript.json",),
        )


def _should_run_another_triage_pass(
    *,
    workbench_state: TriageWorkbenchState,
    pass_index: int,
    max_passes: int,
    pass_edit_events: list[dict] | None = None,
) -> bool:
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
    return operations in (["create_groups"], ["delete_groups", "create_groups"])


__all__ = [
    "run_repository_triage_agent",
]
