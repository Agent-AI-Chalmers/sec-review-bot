import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.delivery_stages.model import DeliveryPlanningCase
from sec_review_agents.delivery_stages.planning.agent_passes import (
    DeliveryPlanningMode,
    _should_run_another_delivery_planning_pass,
    run_delivery_planning,
)
from sec_review_agents.delivery_stages.planning.stage import (
    build_skipped_delivery_plan,
    persist_delivery_plan,
)


def test_skipped_delivery_plan_build_and_persistence_are_separate(tmp_path) -> None:
    result = build_skipped_delivery_plan(total_case_count=3)
    result_path = tmp_path / "delivery-planning" / "delivery-plan.json"

    assert not result_path.exists()

    persist_delivery_plan(run_artifacts_root=tmp_path, result=result)

    assert json.loads(result_path.read_text(encoding="utf-8")) == result.model_dump(
        mode="json"
    )


def test_delivery_planning_reentrant_pass_gate_preserves_single_pass_default() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])

    assert not _should_run_another_delivery_planning_pass(
        workbench_state=workbench_state,
        pass_index=0,
        max_passes=1,
        pass_edit_events=[],
    )
    assert _should_run_another_delivery_planning_pass(
        workbench_state=workbench_state,
        pass_index=0,
        max_passes=2,
        pass_edit_events=[],
    )

    workbench_state.create_groups(
        groups=[
            {
                "kind": "delivery",
                "item_ids": ["case-a", "case-b"],
                "reason": "Combined delivery.",
            }
        ]
    )

    assert not _should_run_another_delivery_planning_pass(
        workbench_state=workbench_state,
        pass_index=0,
        max_passes=2,
        pass_edit_events=[
            {
                "operation": "update_group",
            }
        ],
    )


def test_delivery_planning_reentrant_pass_gate_triggers_after_batch_create() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    workbench_state.create_groups(
        groups=[
            {
                "kind": "delivery",
                "item_ids": ["case-a", "case-b"],
                "reason": "Combined delivery.",
            }
        ]
    )

    assert [event["operation"] for event in workbench_state.edit_events] == [
        "create_groups"
    ]
    assert _should_run_another_delivery_planning_pass(
        workbench_state=workbench_state,
        pass_index=0,
        max_passes=2,
        pass_edit_events=workbench_state.edit_events,
    )
    assert not _should_run_another_delivery_planning_pass(
        workbench_state=workbench_state,
        pass_index=1,
        max_passes=2,
        pass_edit_events=workbench_state.edit_events,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("planning_mode", ["single", "batched"])
@pytest.mark.parametrize("max_passes", [0, 1, 2, 10])
async def test_delivery_planning_allows_at_most_one_refinement(
    tmp_path: Path, planning_mode: DeliveryPlanningMode, max_passes: int
) -> None:
    """The budget controls one quality check, not an arbitrary retry loop."""
    pass_indices: list[int] = []

    async def fake_pass(*, workbench_state, pass_index, **_kwargs):
        pass_indices.append(pass_index)
        if pass_index == 0:
            workbench_state.create_groups(
                groups=[{"kind": "delivery", "item_ids": ["a"], "reason": "A"}]
            )

    with patch(
        "sec_review_agents.delivery_stages.planning.agent_passes._run_delivery_planning_agent_pass",
        side_effect=fake_pass,
    ):
        result = await run_delivery_planning(
            delivery_planning_root=tmp_path,
            planning_cases=[
                DeliveryPlanningCase(case_id="a", overview="A", changed_files=[])
            ],
            planning_mode=planning_mode,
            max_passes=max_passes,
        )
    assert pass_indices == ([0, 1] if max_passes > 1 else [0])
    assert result.metadata.planning_pass_count == len(pass_indices)


@pytest.mark.asyncio
async def test_delivery_batch_inputs_preserve_order_and_duplicate_payloads(
    tmp_path: Path,
) -> None:
    """Routing must preserve the agent's input even when batch IDs are reordered."""
    observed: dict[int, list[tuple[str, str]]] = {}

    async def fake_pass(*, workbench_state, planning_cases, pass_meta, **_kwargs):
        observed[pass_meta["index"]] = [
            (case.case_id, case.overview) for case in planning_cases
        ]
        workbench_state.create_groups(
            groups=[
                {
                    "kind": "delivery",
                    "item_ids": workbench_state.ordered_item_ids,
                    "reason": "Batch",
                }
            ]
        )

    cases = [
        DeliveryPlanningCase(case_id=case_id, overview=overview, changed_files=[])
        for case_id, overview in [
            ("c", "C"),
            ("b", "first B"),
            ("a", "A"),
            (" b ", "second B"),
        ]
    ]
    with (
        patch(
            "sec_review_agents.delivery_stages.planning.agent_passes.planning_case_id_batches",
            return_value=[["a", "b", "missing"], ["c"]],
        ),
        patch(
            "sec_review_agents.delivery_stages.planning.agent_passes._run_delivery_planning_agent_pass",
            side_effect=fake_pass,
        ),
    ):
        await run_delivery_planning(
            delivery_planning_root=tmp_path,
            planning_cases=cases,
            planning_mode="batched",
            max_passes=1,
        )
    assert observed == {
        1: [("b", "first B"), ("a", "A"), (" b ", "second B")],
        2: [("c", "C")],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("skipped", [False, True])
async def test_delivery_plan_preserves_artifact_shape_and_typed_metadata(
    tmp_path: Path, skipped: bool
) -> None:
    """Typed metadata must preserve old JSON, including the skipped-only count."""
    from temporalio.contrib.pydantic import pydantic_data_converter

    from sec_review_agents.delivery_stages.model import DeliveryPlan

    counts = {"input_case_count": 0, "delivery_count": 0}
    if skipped:
        counts["total_case_count"] = 3
    payload: dict[str, object] = {
        "status": "skipped" if skipped else "completed",
        "metadata": {
            "planning_mode": "skipped" if skipped else "batched",
            "planning_pass_count": 0 if skipped else 1,
            "batch_size": None if skipped else 30,
        },
        "counts": counts,
        "deliveries": [],
    }
    plan = DeliveryPlan.model_validate(payload)
    restored = (
        await pydantic_data_converter.decode(
            await pydantic_data_converter.encode([plan]), [DeliveryPlan]
        )
    )[0]
    assert restored == plan
    assert restored.metadata.planning_pass_count == (0 if skipped else 1)
    persist_delivery_plan(run_artifacts_root=tmp_path, result=restored)
    assert (
        json.loads((tmp_path / "delivery-planning/delivery-plan.json").read_text())
        == payload
    )


@pytest.mark.parametrize("invalid", ["2", True, -1])
def test_delivery_plan_rejects_invalid_pass_count(invalid) -> None:
    from pydantic import ValidationError

    from sec_review_agents.delivery_stages.model import DeliveryPlanningMetadata

    with pytest.raises(ValidationError, match="planning_pass_count"):
        DeliveryPlanningMetadata.model_validate(
            {
                "planning_mode": "single",
                "planning_pass_count": invalid,
                "batch_size": None,
            }
        )
