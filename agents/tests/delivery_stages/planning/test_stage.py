import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.delivery_stages.model import DeliveryCaseInput
from sec_review_agents.delivery_stages.planning.stage import (
    DeliveryPlanningMode,
    build_skipped_delivery_plan,
    generate_delivery_plan,
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


@pytest.mark.asyncio
@pytest.mark.parametrize("planning_mode", ["single", "batched"])
@pytest.mark.parametrize("draft", ["valid", "repaired", "incomplete"])
async def test_delivery_planning_always_refines_once(
    tmp_path: Path, planning_mode: DeliveryPlanningMode, draft: str
) -> None:
    """Refine even edited drafts; reject incomplete state after that one chance to repair."""
    phases: list[str] = []

    async def fake_pass(*, workbench_state, phase, **_kwargs):
        phases.append(phase)
        if (phase == "draft" and draft == "valid") or (
            phase == "refinement" and draft == "repaired"
        ):
            workbench_state.create_group(kind="delivery", item_ids=["a"], reason="A")

    with patch(
        "sec_review_agents.delivery_stages.planning.stage._invoke_delivery_planner",
        side_effect=fake_pass,
    ):
        if draft == "incomplete":
            with pytest.raises(RuntimeError, match="incomplete"):
                result = await generate_delivery_plan(
                    run_artifacts_root=tmp_path,
                    case_results=[
                        DeliveryCaseInput(
                            case_id="a",
                            mitigation_overview="A",
                            mitigator_file_changes=[],
                            disposition="keep",
                            reason=None,
                            mitigator_patch_diff=None,
                        )
                    ],
                    planning_mode=planning_mode,
                )
        else:
            result = await generate_delivery_plan(
                run_artifacts_root=tmp_path,
                case_results=[
                    DeliveryCaseInput(
                        case_id="a",
                        mitigation_overview="A",
                        mitigator_file_changes=[],
                        disposition="keep",
                        reason=None,
                        mitigator_patch_diff=None,
                    )
                ],
                planning_mode=planning_mode,
            )
            assert result.metadata.agent_run_count == len(phases)
            artifact = json.loads(
                (tmp_path / "delivery-planning/delivery-plan.json").read_text()
            )
            assert type(result).model_validate(artifact) == result

    assert phases == ["draft", "refinement"]
    if draft == "incomplete":
        assert not (tmp_path / "delivery-planning/delivery-plan.json").exists()


@pytest.mark.asyncio
async def test_delivery_batch_inputs_preserve_order_and_duplicate_payloads(
    tmp_path: Path,
) -> None:
    """Routing must preserve the agent's input even when batch IDs are reordered."""
    observed: dict[int, list[tuple[str, str]]] = {}

    async def fake_pass(
        *, workbench_state, planning_cases, phase, batch_index=None, **_kwargs
    ):
        if phase == "refinement":
            return
        assert batch_index is not None
        observed[batch_index] = [
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
        DeliveryCaseInput(
            case_id=case_id,
            mitigation_overview=overview,
            mitigator_file_changes=[],
            disposition="keep",
            reason=None,
            mitigator_patch_diff=None,
        )
        for case_id, overview in [
            ("c", "C"),
            ("b", "first B"),
            ("a", "A"),
            (" b ", "second B"),
        ]
    ]
    with (
        patch(
            "sec_review_agents.delivery_stages.planning.stage.planning_case_id_batches",
            return_value=[["a", "b", "missing"], ["c"]],
        ),
        patch(
            "sec_review_agents.delivery_stages.planning.stage._invoke_delivery_planner",
            side_effect=fake_pass,
        ),
    ):
        await generate_delivery_plan(
            run_artifacts_root=tmp_path,
            case_results=cases,
            planning_mode="batched",
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
    """Metadata must survive persistence and Temporal conversion, including skipped counts."""
    from temporalio.contrib.pydantic import pydantic_data_converter

    from sec_review_agents.delivery_stages.model import DeliveryPlan

    counts = {"input_case_count": 0, "delivery_count": 0}
    if skipped:
        counts["total_case_count"] = 3
    payload: dict[str, object] = {
        "status": "skipped" if skipped else "completed",
        "metadata": {
            "planning_mode": "skipped" if skipped else "batched",
            "agent_run_count": 0 if skipped else 1,
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
    assert restored.metadata.agent_run_count == (0 if skipped else 1)
    persist_delivery_plan(run_artifacts_root=tmp_path, result=restored)
    assert (
        json.loads((tmp_path / "delivery-planning/delivery-plan.json").read_text())
        == payload
    )


@pytest.mark.parametrize("invalid", ["2", True, -1])
def test_delivery_plan_rejects_invalid_agent_run_count(invalid) -> None:
    from pydantic import ValidationError

    from sec_review_agents.delivery_stages.model import DeliveryPlanningMetadata

    with pytest.raises(ValidationError, match="agent_run_count"):
        DeliveryPlanningMetadata.model_validate(
            {
                "planning_mode": "single",
                "agent_run_count": invalid,
                "batch_size": None,
            }
        )
