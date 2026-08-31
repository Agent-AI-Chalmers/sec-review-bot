from typing import Any

from sec_review_agents.utils.markdown import (
    compact_plain_text,
    inline_code,
    md,
    plain_text,
)
from sec_review_agents.utils.structured_renderer import (
    StructuredRenderSchema,
    render_structured_markdown,
)

PREVIEW_STAGE_SUMMARY_SCHEMA = StructuredRenderSchema(
    key_labels={
        "changed_files": "Changed files",
        "patch_coverage": "Patch coverage",
        "patch_findings": "Patch findings",
        "regression_status": "Regression status",
        "resolution_next_step": "Resolution next step",
        "residual_risks": "Residual risks",
        "review_target_claim": "Review target claim",
        "validation_level": "Validation level",
        "verification_findings": "Verification findings",
    },
    field_order={
        "patch_coverage": 10,
        "regression_status": 20,
        "resolution_next_step": 30,
        "validation_level": 40,
        "review_target_claim": 50,
        "changed_files": 60,
        "patch_findings": 70,
        "verification_findings": 80,
        "residual_risks": 90,
    },
)


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def render_mitigation_preview_lines(
    mitigation: dict[str, Any],
    *,
    fallback: str = "No mitigation overview was recorded.",
) -> list[str]:
    lines = render_structured_markdown(
        {
            "overview": compact_plain_text(mitigation.get("overview")) or fallback,
            "changed_files": as_list(mitigation.get("changed_files")),
        },
        schema=PREVIEW_STAGE_SUMMARY_SCHEMA,
    )
    return lines or [fallback]


def render_verification_preview_lines(
    verification: dict[str, Any],
    *,
    fallback: str = "No verification overview was recorded.",
) -> list[str]:
    lines = render_structured_markdown(
        {
            "overview": compact_plain_text(verification.get("overview")) or fallback,
            "patch_coverage": verification.get("patch_coverage"),
            "regression_status": verification.get("regression_status"),
            "resolution_next_step": verification.get("resolution_next_step"),
            "validation_level": verification.get("validation_level"),
            "review_target_claim": verification.get("review_target_claim"),
            "patch_findings": as_list(verification.get("patch_findings")),
            "verification_findings": as_list(verification.get("verification_findings")),
            "residual_risks": as_list(verification.get("residual_risks")),
        },
        schema=PREVIEW_STAGE_SUMMARY_SCHEMA,
    )
    return lines or [fallback]


def _priority(item: dict[str, Any]) -> int:
    value = item.get("priority")
    return value if isinstance(value, int) else 1_000_000


def _narrative_items(narratives: Any) -> list[dict[str, Any]]:
    items = [item for item in as_list(narratives) if isinstance(item, dict)]
    items.sort(key=_priority)
    return items


def _string_list_section(title: str, values: Any) -> list[str]:
    items = [compact_plain_text(item) for item in as_list(values)]
    items = [item for item in items if item]
    if not items:
        return []
    return [
        "",
        f"{title}:",
        "",
        *[md(t"- {item}") for item in items],
    ]


def _location_section(locations: Any) -> list[str]:
    items = [item for item in as_list(locations) if isinstance(item, dict)]
    if not items:
        return []
    lines = ["", "Locations:", ""]
    for item in items:
        file_path = compact_plain_text(item.get("file"))
        line = item.get("line")
        label = compact_plain_text(item.get("label"))
        anchor = inline_code(
            f"{file_path}:{line}" if file_path and isinstance(line, int) else file_path,
            "unknown",
        )
        if label:
            rendered_label = md(t"{label}")
            lines.append(f"- {anchor}: {rendered_label}")
        else:
            lines.append(f"- {anchor}")
    return lines


def _nearby_paths_section(paths: Any) -> list[str]:
    items = [item for item in as_list(paths) if isinstance(item, dict)]
    if not items:
        return []
    lines = ["", "Reviewed nearby paths:", ""]
    for item in items:
        label = inline_code(item.get("label"), "unnamed path")
        relationship = inline_code(item.get("relationship"), "unknown")
        note = compact_plain_text(item.get("note"))
        if note:
            rendered_note = md(t"{note}")
            lines.append(f"- {label}: {relationship} - {rendered_note}")
        else:
            lines.append(f"- {label}: {relationship}")
    return lines


def _control_review_section(control_review: Any) -> list[str]:
    if not isinstance(control_review, dict):
        return []

    lines: list[str] = []
    for title, key in (
        ("Reachable assets", "reachable_assets"),
        ("Security controls", "security_controls"),
        ("Control limits", "control_limits"),
    ):
        lines.extend(_string_list_section(title, control_review.get(key)))

    if not lines:
        return []
    return ["", "Control review:", *lines]


def _narrative_body_lines(item: dict[str, Any]) -> list[str]:
    flow_review = as_dict(item.get("flow_review"))
    support_review = as_dict(item.get("support_review"))
    scope_review = as_dict(item.get("scope_review"))
    cwe_mapping = as_dict(item.get("cwe_mapping"))
    meta = [
        ("Verdict", item.get("verdict")),
        ("Vulnerability type", item.get("vulnerability_type")),
        ("Validation level", item.get("validation_level")),
        ("Scope shape", scope_review.get("scope_shape")),
        ("Shared boundary", scope_review.get("shared_boundary")),
        (
            "CWE",
            " - ".join(
                part
                for part in [
                    compact_plain_text(cwe_mapping.get("cwe_id")),
                    compact_plain_text(cwe_mapping.get("cwe_name")),
                ]
                if part
            ),
        ),
    ]
    meta_lines = [
        f"- {label}: {inline_code(value)}"
        for label, value in meta
        if compact_plain_text(value)
    ]

    lines: list[str] = []
    if meta_lines:
        lines.extend([*meta_lines, ""])

    description = compact_plain_text(item.get("description"))
    if description:
        lines.extend([description, ""])

    lines.extend(
        [
            *_location_section(item.get("locations")),
            *_string_list_section("Source facts", flow_review.get("source_facts")),
            *_string_list_section("Sink facts", flow_review.get("sink_facts")),
            *_string_list_section(
                "Supported inferences", support_review.get("supported_inferences")
            ),
            *_string_list_section("Proof gaps", support_review.get("proof_gaps")),
            *_control_review_section(item.get("control_review")),
            *_nearby_paths_section(scope_review.get("reviewed_nearby_paths")),
        ]
    )

    cwe_rationale = compact_plain_text(cwe_mapping.get("cwe_rationale"))
    if cwe_rationale:
        lines.extend(["", "CWE rationale:", "", cwe_rationale])

    lines.append("")
    return lines


def render_analysis_narratives(
    narratives: Any,
) -> list[str]:
    items = _narrative_items(narratives)
    if not items:
        return []

    lines = ["Narratives:"]
    for index, item in enumerate(items, start=1):
        title = compact_plain_text(item.get("title"), f"Narrative {index}")
        lines.extend([md(t"**{title}**"), *_narrative_body_lines(item)])
    return lines


def patch_block(patch_diff: Any) -> list[str]:
    patch = plain_text(patch_diff).strip()
    lines = [
        "## Final Patch Preview",
        "",
        "<details>",
        "<summary>View final patch</summary>",
        "",
    ]
    if patch:
        lines.extend(["```diff", patch, "```"])
    else:
        lines.append("No text patch preview was available.")
    lines.extend(["", "</details>"])
    return lines


def final_patch_block_from_diff(
    *,
    patch: str,
    skipped_paths: list[str] | None = None,
) -> list[str]:
    skipped_paths = skipped_paths or []
    lines = [
        "## Final Patch Preview",
        "",
        "<details>",
        "<summary>View final patch</summary>",
        "",
    ]
    if patch.strip():
        lines.extend(["```diff", patch.strip(), "```"])
    else:
        lines.append("No text patch preview was available.")
    if skipped_paths:
        lines.extend(
            [
                "",
                "Skipped non-text file changes:",
                "",
                *[f"- {inline_code(path)}" for path in skipped_paths],
            ]
        )
    lines.extend(["", "</details>"])
    return lines
