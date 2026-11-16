import asyncio
from collections import defaultdict
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from sec_review_agents.agents.delivery_planning.agent import (
    run_delivery_planning_agent,
)
from sec_review_agents.agents.delivery_planning.backend import (
    create_repository_delivery_planning_backend,
)
from sec_review_agents.agents.delivery_planning.prompts import (
    DeliveryPlanningPhase,
    build_repository_delivery_planning_user_prompt,
    build_repository_delivery_planning_workbench_system_prompt,
)
from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.delivery_stages.model import (
    DeliveryCaseInput,
    DeliveryPlan,
    DeliveryPlanningCase,
    DeliveryPlanningCounts,
    DeliveryPlanningMetadata,
)
from sec_review_agents.delivery_stages.planning.batching import planning_case_id_batches
from sec_review_agents.delivery_stages.planning.input import (
    build_delivery_planning_cases,
    prepare_delivery_planning_patch_view,
)
from sec_review_agents.observability.diagnostics import (
    log_stage_completed,
    log_stage_failed,
    log_stage_started,
)
from sec_review_agents.observability.trace_context import bind_trace_context
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.trajectories import remove_trajectories, trajectory_path
from sec_review_agents.utils.bounded_map import map_bounded
from sec_review_agents.utils.files import persist_json_artifact

DEFAULT_DELIVERY_PLANNING_BATCH_SIZE = 30
DELIVERY_PLANNING_MAX_BATCH_CONCURRENCY = 3
DeliveryPlanningMode = Literal["single", "batched"]


async def generate_delivery_plan(
    *,
    run_artifacts_root: Path,
    case_results: Sequence[DeliveryCaseInput],
    planning_mode: DeliveryPlanningMode = "batched",
    max_batch_size: int = DEFAULT_DELIVERY_PLANNING_BATCH_SIZE,
) -> DeliveryPlan:
    started_at = log_stage_started(
        stage="delivery-planning",
        case_count=len(case_results),
    )
    try:
        delivery_planning_root = run_artifacts_root / "delivery-planning"
        prepare_delivery_planning_patch_view(
            run_artifacts_root=run_artifacts_root,
            case_results=case_results,
        )
        planning_cases = build_delivery_planning_cases(case_results)

        _persist_delivery_planning_input(delivery_planning_root, planning_cases)
        if planning_mode == "batched":
            workbench_state, agent_run_count = await _run_batched_delivery_planning(
                delivery_planning_root=delivery_planning_root,
                planning_cases=planning_cases,
                max_batch_size=max_batch_size,
            )
        else:
            workbench_state, agent_run_count = await _run_single_delivery_planning(
                delivery_planning_root=delivery_planning_root,
                planning_cases=planning_cases,
            )
        constraints = workbench_state.constraints()
        if not constraints["ok"]:
            raise RuntimeError(
                "delivery workbench state is incomplete after agent execution."
            )
        deliveries = workbench_state.export_deliveries()
        result = DeliveryPlan(
            status="completed",
            deliveries=deliveries,
            metadata=DeliveryPlanningMetadata(
                planning_mode=planning_mode,
                agent_run_count=agent_run_count,
                batch_size=max_batch_size if planning_mode == "batched" else None,
            ),
            counts=DeliveryPlanningCounts(
                input_case_count=len(planning_cases),
                delivery_count=len(deliveries),
            ),
        )
        if not result.deliveries:
            raise RuntimeError(
                "Repository delivery-planning workbench state returned no usable deliveries."
            )
        persist_delivery_plan(run_artifacts_root=run_artifacts_root, result=result)
        log_stage_completed(
            stage="delivery-planning",
            started_at=started_at,
            reviewed_case_count=len(case_results),
            conflict_count=0,
            override_count=0,
        )
        return result
    except Exception as error:
        log_stage_failed(
            stage="delivery-planning",
            started_at=started_at,
            error=error,
        )
        raise


def build_skipped_delivery_plan(*, total_case_count: int) -> DeliveryPlan:
    """Build a skipped plan; the workflow activity owns persistence."""
    return DeliveryPlan(
        status="skipped",
        metadata=DeliveryPlanningMetadata(
            planning_mode="skipped",
            agent_run_count=0,
            batch_size=None,
        ),
        counts=DeliveryPlanningCounts(
            input_case_count=0,
            delivery_count=0,
            total_case_count=total_case_count,
        ),
        deliveries=[],
    )


def persist_delivery_plan(*, run_artifacts_root: Path, result: DeliveryPlan) -> None:
    persist_json_artifact(
        run_artifacts_root / "delivery-planning",
        "delivery-plan",
        result.model_dump(mode="json"),
    )


async def _run_single_delivery_planning(
    *,
    delivery_planning_root: Path,
    planning_cases: list[DeliveryPlanningCase],
) -> tuple[DeliveryWorkbenchState, int]:
    workbench_state = DeliveryWorkbenchState.from_items(_planning_items(planning_cases))
    await _invoke_delivery_planner(
        delivery_planning_root=delivery_planning_root,
        workbench_state=workbench_state,
        planning_cases=planning_cases,
        phase="draft",
    )
    await _invoke_delivery_planner(
        delivery_planning_root=delivery_planning_root,
        workbench_state=workbench_state,
        planning_cases=planning_cases,
        phase="refinement",
    )
    return workbench_state, 2


async def _run_batched_delivery_planning(
    *,
    delivery_planning_root: Path,
    planning_cases: list[DeliveryPlanningCase],
    max_batch_size: int,
) -> tuple[DeliveryWorkbenchState, int]:
    global_state = DeliveryWorkbenchState.from_items(_planning_items(planning_cases))
    draft_origins: list[dict] = []
    batches = planning_case_id_batches(planning_cases, max_batch_size=max_batch_size)
    # Route cases once, preserving their original order within each batch.
    batch_cases: list[list[DeliveryPlanningCase]] = [[] for _ in batches]
    batch_indices_by_case_id: dict[str, list[int]] = defaultdict(list)
    for index, case_ids in enumerate(batches):
        for case_id in set(case_ids):
            batch_indices_by_case_id[case_id].append(index)
    for case in planning_cases:
        for index in batch_indices_by_case_id.get(case.case_id.strip(), []):
            batch_cases[index].append(case)

    # Batch drafts run concurrently, but each batch owns its own workbench state.
    # The shared global state is updated only below, in batch index order, so
    # async interleaving cannot reorder or race delivery group creation.

    async def run_batch(index: int) -> list[dict]:
        return await _run_delivery_planning_batch_draft(
            delivery_planning_root=delivery_planning_root,
            batch_cases=batch_cases[index],
            batch_index=index + 1,
        )

    batch_results = await map_bounded(
        range(len(batch_cases)),
        run_batch,
        max_concurrency=DELIVERY_PLANNING_MAX_BATCH_CONCURRENCY,
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

    await _invoke_delivery_planner(
        delivery_planning_root=delivery_planning_root,
        workbench_state=global_state,
        planning_cases=planning_cases,
        phase="refinement",
        draft_origins=draft_origins,
    )

    return global_state, len(batch_results) + 1


async def _run_delivery_planning_batch_draft(
    *,
    delivery_planning_root: Path,
    batch_cases: list[DeliveryPlanningCase],
    batch_index: int,
) -> list[dict]:
    batch_state = DeliveryWorkbenchState.from_items(_planning_items(batch_cases))
    await _invoke_delivery_planner(
        delivery_planning_root=delivery_planning_root,
        batch_index=batch_index,
        workbench_state=batch_state,
        planning_cases=batch_cases,
        phase="draft",
    )
    return batch_state.group_drafts()


async def _invoke_delivery_planner(
    *,
    delivery_planning_root: Path,
    workbench_state: DeliveryWorkbenchState,
    planning_cases: list[DeliveryPlanningCase],
    phase: DeliveryPlanningPhase,
    draft_origins: list[dict] | None = None,
    batch_index: int | None = None,
) -> None:
    artifacts_path = _delivery_planning_artifacts_path(
        delivery_planning_root, phase=phase, batch_index=batch_index
    )
    remove_trajectories((trajectory_path(artifacts_path),))
    backend = create_repository_delivery_planning_backend(
        patch_root=delivery_planning_root / "patches",
    )
    async with amanaged_backend(backend):
        system_prompt = build_repository_delivery_planning_workbench_system_prompt(
            phase=phase
        )
        # Planning may fan out into draft batches before one global refinement.
        # Preserve that shape on every model call instead of flattening it later.
        with bind_trace_context(
            agent_phase=phase,
            batch_index=str(batch_index) if batch_index is not None else None,
        ):
            await run_delivery_planning_agent(
                backend=backend,
                workbench_state=workbench_state,
                system_prompt=system_prompt,
                user_prompt=build_repository_delivery_planning_user_prompt(
                    planning_cases,
                    phase=phase,
                    draft_origins=draft_origins,
                ),
                trajectory_paths=(trajectory_path(artifacts_path),),
            )


def _planning_items(planning_cases: list[DeliveryPlanningCase]) -> list[dict]:
    return [
        {
            "item_id": case_entry.case_id,
            "payload": {
                "overview": case_entry.overview,
                "changed_files": list(case_entry.changed_files),
            },
        }
        for case_entry in planning_cases
    ]


def _delivery_planning_artifacts_path(
    delivery_planning_root: Path,
    *,
    phase: DeliveryPlanningPhase,
    batch_index: int | None = None,
) -> Path:
    if phase == "refinement":
        return delivery_planning_root / "refinement"
    if batch_index is not None:
        return delivery_planning_root / "batches" / f"batch-{batch_index:04d}"
    return delivery_planning_root


def _persist_delivery_planning_input(
    delivery_planning_root: Path, planning_cases: list[DeliveryPlanningCase]
) -> None:
    """Persist archive-only planning input for operator inspection."""
    persist_json_artifact(
        delivery_planning_root,
        "delivery-planning-input",
        {"cases": [case.model_dump(mode="json") for case in planning_cases]},
    )


__all__ = [
    "build_skipped_delivery_plan",
    "generate_delivery_plan",
    "persist_delivery_plan",
]
