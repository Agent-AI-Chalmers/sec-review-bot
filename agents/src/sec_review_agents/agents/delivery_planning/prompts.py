import json
from typing import Any, Literal

from sec_review_agents.delivery_stages.model import DeliveryPlanningCase
from sec_review_agents.resources.loader import (
    join_prompt_sections,
)
from sec_review_agents.utils.markdown import inline_code, md

DeliveryPlanningPhase = Literal["draft", "refinement"]

REPOSITORY_DELIVERY_PLANNING_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Review prepared repository delivery cases before publication.",
    ]
)


def build_repository_delivery_planning_workbench_system_prompt(
    *, phase: DeliveryPlanningPhase = "draft"
) -> str:
    phase_prompt = (
        "delivery-planning/draft-system.md"
        if phase == "draft"
        else "delivery-planning/refinement-system.md"
    )
    return join_prompt_sections(
        [
            "delivery-planning/workbench-system.md",
            phase_prompt,
        ]
    )


def build_repository_delivery_planning_filesystem_system_prompt() -> str:
    return join_prompt_sections(
        [
            "delivery-planning/filesystem-system.md",
        ]
    )


def build_repository_delivery_planning_user_prompt(
    planning_cases: list[DeliveryPlanningCase],
    *,
    phase: DeliveryPlanningPhase = "draft",
    draft_origins: list[dict] | None = None,
) -> str:
    sections = [
        REPOSITORY_DELIVERY_PLANNING_INTRO,
        "",
        "## Delivery Planning Context",
        md(t"- `case_count`: `{len(planning_cases)}`"),
        "- The items below are the complete case inventory for this run.",
        "- Each item payload is stage-provided evidence for delivery planning.",
        "- Use only these items and the current workbench groups; do not infer cases outside this run.",
    ]

    sections.extend(
        [
            "",
            "## Items",
            "",
            _planning_items_intro(phase),
            "",
            "```json",
            json.dumps(
                {"items": _planning_prompt_items(planning_cases)},
                ensure_ascii=False,
                indent=2,
            ),
            "```",
        ]
    )
    if phase == "refinement" and draft_origins:
        sections.extend(
            [
                "",
                "## Draft Origins",
                "",
                (
                    "Use this section only to prioritize refinement attention. "
                    "Groups from different draft scopes may not have been compared "
                    "in the same run."
                ),
                "",
                *_render_draft_origins(draft_origins),
            ]
        )

    return "\n".join(sections)


def _render_draft_origins(draft_origins: list[dict]) -> list[str]:
    lines: list[str] = []
    for origin in draft_origins:
        scope = str(origin.get("scope") or "").strip()
        group_ids = [
            str(group_id).strip()
            for group_id in (origin.get("group_ids") or [])
            if str(group_id).strip()
        ]
        if not scope or not group_ids:
            continue
        rendered_group_ids = ", ".join(inline_code(group_id) for group_id in group_ids)
        lines.append(md(t"- `{scope}`: ") + rendered_group_ids)
    return lines


def _planning_items_intro(phase: DeliveryPlanningPhase) -> str:
    if phase == "refinement":
        return (
            "Use these item payloads as the complete evidence inventory for this "
            "global refinement."
        )
    return "Use these item payloads as the complete evidence inventory for this draft."


def _planning_prompt_items(planning_cases: list[DeliveryPlanningCase]) -> list[dict]:
    items: list[dict] = []
    for case_entry in planning_cases:
        case_id = case_entry.case_id.strip()
        if not case_id:
            continue
        payload: dict[str, Any] = {"overview": case_entry.overview.strip() or None}
        changed_files = _planning_prompt_changed_files(case_entry)
        if changed_files:
            payload["changed_files"] = changed_files
        items.append({"item_id": case_id, "payload": payload})
    return items


def _planning_prompt_changed_files(case_entry: DeliveryPlanningCase) -> list[str]:
    changed_files: list[str] = []
    seen: set[str] = set()
    for value in case_entry.changed_files:
        path = value.strip().lstrip("/")
        if not path or path in seen:
            continue
        seen.add(path)
        changed_files.append(path)
    return changed_files
