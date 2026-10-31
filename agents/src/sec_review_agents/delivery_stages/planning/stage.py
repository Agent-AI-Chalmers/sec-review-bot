from collections.abc import Sequence
from pathlib import Path

from sec_review_agents.delivery_stages.model import DeliveryCaseInput, DeliveryPlan
from sec_review_agents.delivery_stages.planning.agent_passes import (
    run_delivery_planning,
)
from sec_review_agents.delivery_stages.planning.input import (
    build_delivery_planning_cases,
    prepare_delivery_planning_patch_view,
)
from sec_review_agents.observability.diagnostics import (
    log_stage_completed,
    log_stage_failed,
    log_stage_started,
)
from sec_review_agents.utils.files import persist_json_artifact


async def generate_delivery_plan(
    *,
    run_artifacts_root: Path,
    case_results: Sequence[DeliveryCaseInput],
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

        result = await run_delivery_planning(
            delivery_planning_root=delivery_planning_root,
            planning_cases=planning_cases,
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
        metadata={
            "planning_mode": "skipped",
            "planning_pass_count": 0,
            "batch_size": None,
        },
        counts={
            "input_case_count": 0,
            "delivery_count": 0,
            "total_case_count": total_case_count,
        },
        deliveries=[],
    )


def persist_delivery_plan(*, run_artifacts_root: Path, result: DeliveryPlan) -> None:
    persist_json_artifact(
        run_artifacts_root / "delivery-planning",
        "delivery-plan",
        result.model_dump(mode="json"),
    )


__all__ = [
    "build_skipped_delivery_plan",
    "generate_delivery_plan",
    "persist_delivery_plan",
]
