from collections.abc import Sequence
from pathlib import Path
from typing import Any

from sec_review_agents.delivery_stages.model import DeliveryCaseInput
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
from sec_review_agents.utils.files import persist_json


async def generate_delivery_plan(
    *,
    run_artifacts_root: Path,
    case_results: Sequence[DeliveryCaseInput],
) -> dict[str, Any]:
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

        agent_run = await run_delivery_planning(
            delivery_planning_root=delivery_planning_root,
            planning_cases=planning_cases,
        )
        planned_entries = agent_run["deliveries"]

        if not planned_entries:
            raise RuntimeError(
                "Repository delivery-planning workbench state returned no usable deliveries."
            )

        counts = dict(agent_run["counts"])
        counts["delivery_count"] = len(planned_entries)
        result: dict[str, Any] = {
            "status": "completed",
            "metadata": agent_run["metadata"],
            "counts": counts,
            "deliveries": planned_entries,
        }
        persist_json(
            delivery_planning_root,
            "delivery-plan.json",
            result,
        )
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


def build_skipped_delivery_plan(
    *, run_artifacts_root: Path, total_case_count: int
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "skipped",
        "metadata": {
            "planning_mode": "skipped",
            "planning_pass_count": 0,
            "batch_size": None,
        },
        "counts": {
            "input_case_count": 0,
            "delivery_count": 0,
            "total_case_count": total_case_count,
        },
        "deliveries": [],
    }
    persist_json(
        run_artifacts_root / "delivery-planning",
        "delivery-plan.json",
        result,
    )
    return result


__all__ = [
    "build_skipped_delivery_plan",
    "generate_delivery_plan",
]
