from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.delivery_stages.planning.agent_passes import (
    _should_run_another_delivery_planning_pass,
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
