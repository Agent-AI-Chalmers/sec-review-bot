import json

import pytest

from sec_review_agents.agents.delivery_planning.prompts import (
    DeliveryPlanningPassKind,
    build_repository_delivery_planning_user_prompt,
    build_repository_delivery_planning_workbench_system_prompt,
)
from sec_review_agents.resources.loader import join_prompt_sections


def test_delivery_planning_uses_pass_specific_system_prompts() -> None:
    """Select exactly one pass contract after the shared workbench contract."""
    draft_prompt = build_repository_delivery_planning_workbench_system_prompt(
        pass_kind="draft"
    )
    refinement_prompt = build_repository_delivery_planning_workbench_system_prompt(
        pass_kind="refinement"
    )

    assert draft_prompt == join_prompt_sections(
        [
            "delivery-planning/workbench-system.md",
            "delivery-planning/draft-pass-system.md",
        ]
    )
    assert refinement_prompt == join_prompt_sections(
        [
            "delivery-planning/workbench-system.md",
            "delivery-planning/refinement-pass-system.md",
        ]
    )


@pytest.mark.parametrize("pass_kind", [None, "draft", "refinement"])
def test_delivery_planning_user_prompt_serializes_case_items(
    pass_kind: DeliveryPlanningPassKind | None,
) -> None:
    user_prompt = build_repository_delivery_planning_user_prompt(
        [
            {
                "case_id": "case-a",
                "overview": "Case A mitigation overview.",
                "changed_files": ["src/a.ts"],
            }
        ],
        pass_kind=pass_kind,
    )

    json_block = user_prompt.split("```json", 1)[1].split("```", 1)[0]
    assert json.loads(json_block) == {
        "items": [
            {
                "item_id": "case-a",
                "payload": {
                    "overview": "Case A mitigation overview.",
                    "changed_files": ["src/a.ts"],
                },
            }
        ]
    }


def test_delivery_planning_refinement_prompt_identifies_global_pass() -> None:
    draft_prompt = build_repository_delivery_planning_user_prompt([])
    refinement_prompt = build_repository_delivery_planning_user_prompt(
        [], pass_kind="refinement"
    )

    assert "global refinement pass" in refinement_prompt
    assert "global refinement pass" not in draft_prompt
