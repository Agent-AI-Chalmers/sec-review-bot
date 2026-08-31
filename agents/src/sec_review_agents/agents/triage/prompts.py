from collections.abc import Mapping, Sequence
from typing import Any, Literal

from sec_review_agents.resources.loader import join_prompt_sections
from sec_review_agents.utils.markdown import (
    inline_code,
    json_section,
    md,
    scalar_section,
)

TriagePassKind = Literal["draft", "refinement"]

REPOSITORY_TRIAGE_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Triage repository discovery items using the triage workbench.",
    ]
)


def build_repository_triage_system_prompt(
    *, pass_kind: TriagePassKind = "draft"
) -> str:
    return join_prompt_sections(
        [
            "triager/workbench-system.md",
            _triage_pass_prompt(pass_kind),
        ]
    )


def _triage_pass_prompt(pass_kind: TriagePassKind) -> str:
    if pass_kind == "draft":
        return "triager/draft-pass-system.md"
    return "triager/refinement-pass-system.md"


def build_repository_triage_user_prompt(
    *,
    items: Sequence[Mapping[str, Any]],
    pass_kind: str,
    draft_origins: Sequence[Mapping[str, Any]] | None = None,
) -> str:
    sections = [REPOSITORY_TRIAGE_INTRO]
    sections.extend(
        [
            "",
            scalar_section(
                "Triage Context",
                {
                    "item_count": len(items),
                    "pass_kind": pass_kind,
                },
            ),
            "",
            "## Items",
            "",
            "Use these item payloads as the complete evidence inventory for this pass.",
            "",
            json_section("Triage Items", {"items": items}),
        ]
    )
    if pass_kind == "refinement" and draft_origins:
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


def _render_draft_origins(
    draft_origins: Sequence[Mapping[str, Any]],
) -> list[str]:
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
