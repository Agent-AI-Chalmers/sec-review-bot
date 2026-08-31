import json
from typing import Any, Literal

from sec_review_agents.resources.loader import (
    join_prompt_sections,
)
from sec_review_agents.utils.markdown import inline_code, md

DeliveryPlanningPassKind = Literal["draft", "refinement"]

REPOSITORY_DELIVERY_PLANNING_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Review prepared repository delivery cases before publication.",
    ]
)


def build_repository_delivery_planning_workbench_system_prompt(
    *, pass_kind: DeliveryPlanningPassKind = "draft"
) -> str:
    pass_prompt = (
        "delivery-planning/draft-pass-system.md"
        if pass_kind == "draft"
        else "delivery-planning/refinement-pass-system.md"
    )
    return join_prompt_sections(
        [
            "delivery-planning/workbench-system.md",
            pass_prompt,
        ]
    )


def build_repository_delivery_planning_filesystem_system_prompt() -> str:
    return join_prompt_sections(
        [
            "delivery-planning/filesystem-system.md",
        ]
    )


def build_repository_delivery_planning_user_prompt(
    planning_cases: list[dict[str, Any]],
    *,
    pass_kind: DeliveryPlanningPassKind | None = None,
    draft_origins: list[dict] | None = None,
) -> str:
    resolved_pass_kind = pass_kind or "draft"

    sections = [
        REPOSITORY_DELIVERY_PLANNING_INTRO,
        "",
        "## Delivery Planning Context",
        md(t"- `case_count`: `{len(planning_cases)}`"),
        "- The items below are the complete case inventory for this pass.",
        "- Each item payload is stage-provided evidence for delivery planning.",
        "- Use only these items and the current workbench groups; do not infer cases outside this pass.",
    ]

    sections.extend(
        [
            "",
            "## Items",
            "",
            _planning_items_intro(resolved_pass_kind),
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
    if resolved_pass_kind == "refinement" and draft_origins:
        sections.extend(
            [
                "",
                "## Draft Origins",
                "",
                (
                    "Use this section only to prioritize refinement attention. "
                    "Groups from different draft scopes may not have been compared "
                    "in the same pass."
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


def _planning_items_intro(pass_kind: DeliveryPlanningPassKind) -> str:
    if pass_kind == "refinement":
        return (
            "Use these item payloads as the complete evidence inventory for this "
            "global refinement pass."
        )
    return "Use these item payloads as the complete evidence inventory for this draft pass."


def _planning_prompt_items(planning_cases: list[dict[str, Any]]) -> list[dict]:
    items: list[dict] = []
    for case_entry in planning_cases:
        case_id = str(case_entry.get("case_id") or "").strip()
        if not case_id:
            continue
        items.append(
            {
                "item_id": case_id,
                "payload": _planning_prompt_item_payload(case_entry),
            }
        )
    return items


def _planning_prompt_item_payload(case_entry: dict) -> dict:
    payload: dict[str, Any] = {
        "overview": _planning_prompt_overview(case_entry),
    }
    changed_files = _planning_prompt_changed_files(case_entry)
    if changed_files:
        payload["changed_files"] = changed_files
    return payload


def _planning_prompt_overview(case_entry: dict) -> str | None:
    overview = str(case_entry.get("overview") or "").strip()
    return overview or None


def _planning_prompt_changed_files(case_entry: dict) -> list[str]:
    changed_files: list[str] = []
    seen: set[str] = set()
    for value in case_entry.get("changed_files") or []:
        if not isinstance(value, str):
            continue
        path = value.strip().lstrip("/")
        if not path or path in seen:
            continue
        seen.add(path)
        changed_files.append(path)
    return changed_files
