import json

import pytest

from sec_review_agents.agents.delivery_planning.prompts import (
    DeliveryPlanningPhase,
    build_repository_delivery_planning_user_prompt,
    build_repository_delivery_planning_workbench_system_prompt,
)
from sec_review_agents.delivery_stages.model import DeliveryPlanningCase
from sec_review_agents.resources.loader import join_prompt_sections


def test_delivery_planning_uses_phase_specific_system_prompts() -> None:
    """Select exactly one phase contract after the shared workbench contract."""
    draft_prompt = build_repository_delivery_planning_workbench_system_prompt(
        phase="draft"
    )
    refinement_prompt = build_repository_delivery_planning_workbench_system_prompt(
        phase="refinement"
    )

    assert draft_prompt == join_prompt_sections(
        [
            "delivery-planning/workbench-system.md",
            "delivery-planning/draft-system.md",
        ]
    )
    assert refinement_prompt == join_prompt_sections(
        [
            "delivery-planning/workbench-system.md",
            "delivery-planning/refinement-system.md",
        ]
    )


@pytest.mark.parametrize("phase", ["draft", "refinement"])
def test_delivery_planning_user_prompt_serializes_case_items(
    phase: DeliveryPlanningPhase,
) -> None:
    user_prompt = build_repository_delivery_planning_user_prompt(
        [
            DeliveryPlanningCase(
                case_id="case-a",
                overview="Case A mitigation overview.",
                changed_files=["src/a.ts"],
            )
        ],
        phase=phase,
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
