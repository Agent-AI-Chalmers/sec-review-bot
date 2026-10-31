import json

from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.delivery_stages.planning.agent_passes import (
    _should_run_another_delivery_planning_pass,
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
