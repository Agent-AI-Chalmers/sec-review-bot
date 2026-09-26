import asyncio
from pathlib import Path
from typing import Any, Literal

from sec_review_agents.agents.delivery_planning.agent import (
    DELIVERY_PLANNING_AGENT_NAME,
    create_delivery_planning_agent_graph,
)
from sec_review_agents.agents.delivery_planning.backend import (
    create_repository_delivery_planning_backend,
)
from sec_review_agents.agents.delivery_planning.prompts import (
    DeliveryPlanningPassKind,
    build_repository_delivery_planning_user_prompt,
    build_repository_delivery_planning_workbench_system_prompt,
)
from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.delivery_stages.planning.batching import planning_case_id_batches
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.utils.files import persist_json

DEFAULT_DELIVERY_PLANNING_PASSES = 2
DEFAULT_DELIVERY_PLANNING_BATCH_SIZE = 30
DELIVERY_PLANNING_MAX_BATCH_CONCURRENCY = 3
DeliveryPlanningMode = Literal["single", "batched"]


def _delivery_planning_pass_artifacts_path(
    delivery_planning_root: Path, pass_meta: dict | None = None
) -> Path:
    pass_meta = pass_meta or {}
    if pass_meta.get("kind") == "batch":
        index = int(pass_meta.get("index") or 0)
        return delivery_planning_root / "batches" / f"batch-{index:04d}"
    if pass_meta.get("kind") == "refinement":
        return delivery_planning_root / "refinement"
    return delivery_planning_root


def persist_delivery_planning_input(
    delivery_planning_root: Path, planning_cases: list[dict[str, Any]]
) -> None:
    """Persist archive-only planning input for operator inspection."""
    persist_json(
        delivery_planning_root,
        "delivery-planning-input.json",
        {"cases": planning_cases},
    )


async def run_delivery_planning(
    *,
    delivery_planning_root: Path,
    planning_cases: list[dict[str, Any]],
    max_passes: int = DEFAULT_DELIVERY_PLANNING_PASSES,
    planning_mode: DeliveryPlanningMode = "batched",
    max_batch_size: int = DEFAULT_DELIVERY_PLANNING_BATCH_SIZE,
) -> dict:
    persist_delivery_planning_input(delivery_planning_root, planning_cases)
    if planning_mode == "batched":
        workbench_state, agent_results = await _run_batched_delivery_planning_passes(
            delivery_planning_root=delivery_planning_root,
            planning_cases=planning_cases,
            max_passes=max_passes,
            max_batch_size=max_batch_size,
        )
    else:
        workbench_state, agent_results = await _run_single_delivery_planning_passes(
            delivery_planning_root=delivery_planning_root,
            planning_cases=planning_cases,
            max_passes=max_passes,
        )
    finish_result = workbench_state.finish()
    if not finish_result["ok"]:
        raise RuntimeError(
            "delivery workbench state is incomplete after agent execution."
        )
    deliveries = finish_result["deliveries"]
    return {
        "agent_result": agent_results[-1] if agent_results else None,
        "agent_results": agent_results,
        "deliveries": deliveries,
        "constraints": finish_result["constraints"],
        "metadata": {
            "planning_mode": planning_mode,
            "planning_pass_count": len(agent_results),
            "batch_size": max_batch_size if planning_mode == "batched" else None,
        },
        "counts": {
            "input_case_count": len(planning_cases),
            "delivery_count": len(deliveries),
        },
    }


async def _run_single_delivery_planning_passes(
    *,
    delivery_planning_root: Path,
    planning_cases: list[dict[str, Any]],
    max_passes: int,
) -> tuple[DeliveryWorkbenchState, list[dict | None]]:
    workbench_state = DeliveryWorkbenchState.from_items(_planning_items(planning_cases))
    agent_results: list[dict | None] = []
    for pass_index in range(max(1, max_passes)):
        edit_event_start = len(workbench_state.edit_events)
        agent_results.append(
            await _run_delivery_planning_agent_pass(
                delivery_planning_root=delivery_planning_root,
                pass_meta={"kind": "refinement"} if pass_index > 0 else None,
                workbench_state=workbench_state,
                planning_cases=planning_cases,
                pass_index=pass_index,
            )
        )
        if not _should_run_another_delivery_planning_pass(
            workbench_state=workbench_state,
            pass_index=pass_index,
            max_passes=max_passes,
            pass_edit_events=workbench_state.edit_events[edit_event_start:],
        ):
            break
    return workbench_state, agent_results


async def _run_batched_delivery_planning_passes(
    *,
    delivery_planning_root: Path,
    planning_cases: list[dict[str, Any]],
    max_passes: int,
    max_batch_size: int,
) -> tuple[DeliveryWorkbenchState, list[dict | None]]:
    global_state = DeliveryWorkbenchState.from_items(_planning_items(planning_cases))
    agent_results: list[dict | None] = []
    draft_origins: list[dict] = []
    batches = planning_case_id_batches(planning_cases, max_batch_size=max_batch_size)
    batch_concurrency = min(
        max(1, len(batches)),
        DELIVERY_PLANNING_MAX_BATCH_CONCURRENCY,
    )

    # Batch drafts run concurrently, but each batch owns its own workbench state.
    # The shared global state is updated only below, in batch index order, so
    # async interleaving cannot reorder or race delivery group creation.
    semaphore = asyncio.Semaphore(batch_concurrency)

    async def run_batch(
        index: int,
        batch_case_ids: list[str],
    ) -> tuple[int, dict | None, list[dict]]:
        async with semaphore:
            agent_result, batch_group_drafts = await _run_delivery_planning_batch_draft(
                delivery_planning_root=delivery_planning_root,
                planning_cases=planning_cases,
                batch_case_ids=batch_case_ids,
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
            run_batch(index, batch_case_ids)
            for index, batch_case_ids in enumerate(batches, start=1)
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
            await _run_delivery_planning_agent_pass(
                delivery_planning_root=delivery_planning_root,
                pass_meta={"kind": "refinement"},
                workbench_state=global_state,
                planning_cases=planning_cases,
                pass_index=pass_index,
                draft_origins=draft_origins,
            )
        )
        if not _should_run_another_delivery_planning_pass(
            workbench_state=global_state,
            pass_index=pass_index,
            max_passes=max_passes,
            pass_edit_events=global_state.edit_events[edit_event_start:],
        ):
            break

    return global_state, agent_results


async def _run_delivery_planning_batch_draft(
    *,
    delivery_planning_root: Path,
    planning_cases: list[dict[str, Any]],
    batch_case_ids: list[str],
    batch: dict,
) -> tuple[dict | None, list[dict]]:
    batch_cases = _planning_cases_for_batch(planning_cases, batch_case_ids)
    batch_state = DeliveryWorkbenchState.from_items(_planning_items(batch_cases))
    agent_result = await _run_delivery_planning_agent_pass(
        delivery_planning_root=delivery_planning_root,
        pass_meta=batch,
        workbench_state=batch_state,
        planning_cases=batch_cases,
        pass_index=0,
    )
    return agent_result, batch_state.group_drafts()


async def _run_delivery_planning_agent_pass(
    *,
    delivery_planning_root: Path,
    workbench_state: DeliveryWorkbenchState,
    planning_cases: list[dict[str, Any]],
    pass_index: int = 0,
    draft_origins: list[dict] | None = None,
    pass_meta: dict | None = None,
) -> dict | None:
    pass_artifacts_path = _delivery_planning_pass_artifacts_path(
        delivery_planning_root, pass_meta
    )
    reset_stage_attempt_artifacts(
        pass_artifacts_path,
        filenames=("transcript.json",),
    )
    backend = create_repository_delivery_planning_backend(
        patch_root=delivery_planning_root / "patches",
    )
    async with amanaged_backend(backend):
        pass_kind: DeliveryPlanningPassKind = (
            "draft" if pass_index <= 0 else "refinement"
        )
        system_prompt = build_repository_delivery_planning_workbench_system_prompt(
            pass_kind=pass_kind
        )
        agent = await create_delivery_planning_agent_graph(
            backend=backend,
            workbench_state=workbench_state,
            system_prompt=system_prompt,
        )
        return await invoke_agent_runtime_graph(
            agent=agent,
            agent_name=DELIVERY_PLANNING_AGENT_NAME,
            system_prompt=system_prompt,
            user_prompt=build_repository_delivery_planning_user_prompt(
                planning_cases,
                pass_kind=pass_kind,
                draft_origins=draft_origins,
            ),
            transcript_paths=(pass_artifacts_path / "transcript.json",),
        )


def _should_run_another_delivery_planning_pass(
    *,
    workbench_state: DeliveryWorkbenchState,
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


def _planning_items(planning_cases: list[dict[str, Any]]) -> list[dict]:
    items: list[dict] = []
    for case_entry in planning_cases:
        case_id = str(case_entry.get("case_id") or "").strip()
        if not case_id:
            continue
        items.append(
            {
                "item_id": case_id,
                "payload": _planning_item_payload(case_entry),
            }
        )
    return items


def _planning_item_payload(case_entry: dict) -> dict:
    payload: dict[str, Any] = {
        "overview": _planning_overview(case_entry),
    }
    changed_files = _planning_changed_files(case_entry)
    if changed_files:
        payload["changed_files"] = changed_files
    return payload


def _planning_overview(case_entry: dict) -> str | None:
    overview = str(case_entry.get("overview") or "").strip()
    return overview or None


def _planning_changed_files(case_entry: dict) -> list[str]:
    changed_files: list[str] = []
    seen: set[str] = set()
    for value in case_entry.get("changed_files") or []:
        path = _normalized_planning_path(value)
        if not path or path in seen:
            continue
        seen.add(path)
        changed_files.append(path)
    return changed_files


def _normalized_planning_path(value) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lstrip("/")
    return normalized or None


def _planning_cases_for_batch(
    planning_cases: list[dict[str, Any]], batch_case_ids: list[str]
) -> list[dict[str, Any]]:
    requested_case_ids = {
        str(case_id or "").strip()
        for case_id in batch_case_ids
        if str(case_id or "").strip()
    }
    return [
        dict(case_entry)
        for case_entry in planning_cases
        if str(case_entry.get("case_id") or "").strip() in requested_case_ids
    ]


__all__ = [
    "run_delivery_planning",
]
