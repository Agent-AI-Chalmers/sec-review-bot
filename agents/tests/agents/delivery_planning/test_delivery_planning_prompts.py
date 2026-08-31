from sec_review_agents.agents.delivery_planning.prompts import (
    build_repository_delivery_planning_user_prompt,
    build_repository_delivery_planning_workbench_system_prompt,
)


def test_delivery_planning_uses_pass_specific_system_prompts() -> None:
    draft_prompt = build_repository_delivery_planning_workbench_system_prompt(
        pass_kind="draft"
    )
    refinement_prompt = build_repository_delivery_planning_workbench_system_prompt(
        pass_kind="refinement"
    )

    assert "# Draft Pass" in draft_prompt
    assert "Prefer `create_groups`" in draft_prompt
    assert "# Refinement Pass" not in draft_prompt
    assert "# Refinement Pass" in refinement_prompt
    assert "Call `read_groups` once at the start" in refinement_prompt
    assert "concrete targeted group edits" in refinement_prompt
    assert "# Draft Pass" not in refinement_prompt


def test_delivery_planning_prompt_treats_workbench_state_items_as_inventory() -> None:
    draft_prompt = build_repository_delivery_planning_workbench_system_prompt(
        pass_kind="draft"
    )

    assert "complete retained-case inventory for this pass" in draft_prompt
    assert "workbench items" in draft_prompt
    assert "cases outside this pass" in draft_prompt


def test_delivery_planning_draft_user_prompt_inlines_prompt_items() -> None:
    user_prompt = build_repository_delivery_planning_user_prompt(
        [
            {
                "case_id": "case-a",
                "overview": "Case A mitigation overview.",
                "changed_files": ["src/a.ts"],
            }
        ],
    )

    assert "complete case inventory" in user_prompt
    assert "case_count" in user_prompt
    assert "## Items" in user_prompt
    assert "Case A mitigation overview." in user_prompt
    assert "src/a.ts" in user_prompt
    assert "## Case Cards" not in user_prompt


def test_delivery_planning_refinement_user_prompt_inlines_prompt_items() -> None:
    user_prompt = build_repository_delivery_planning_user_prompt(
        [
            {
                "case_id": "case-a",
                "overview": "Case A mitigation overview.",
                "changed_files": ["src/a.ts"],
            }
        ],
        pass_kind="refinement",
    )

    assert "complete case inventory" in user_prompt
    assert "case_count" in user_prompt
    assert "## Items" in user_prompt
    assert "global refinement pass" in user_prompt
    assert "Case A mitigation overview." in user_prompt
    assert "src/a.ts" in user_prompt


def test_delivery_planning_refinement_user_prompt_can_be_pass_kind_driven() -> None:
    user_prompt = build_repository_delivery_planning_user_prompt(
        [
            {
                "case_id": "case-a",
                "overview": "Case A mitigation overview.",
                "changed_files": ["src/a.ts"],
            }
        ],
        pass_kind="refinement",
    )

    assert "case_count" in user_prompt
    assert "## Items" in user_prompt
    assert "global refinement pass" in user_prompt
    assert "Case A mitigation overview." in user_prompt
    assert "src/a.ts" in user_prompt
