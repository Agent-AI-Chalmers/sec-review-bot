from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from sec_review_agents.utils.markdown import (
    compact_plain_text,
    format_scalar,
    inline_code,
    markdown_text,
    md,
)


@dataclass(frozen=True)
class StructuredRenderSchema:
    """Lightweight display hints, not a contract JSON Schema mirror."""

    hidden_keys: frozenset[str] = frozenset(
        {"raw", "debug", "diagnostics", "transcript", "transcripts"}
    )
    summary_keys: tuple[str, ...] = (
        "overview",
        "summary",
        "description",
        "reason",
        "note",
    )
    anchor_keys: tuple[str, ...] = ("path", "file")
    title_keys: tuple[str, ...] = ("title", "summary", "label", "name", "id")
    key_labels: Mapping[str, str] = field(default_factory=dict)
    field_order: Mapping[str, int] = field(default_factory=dict)


StructuredRenderProfile = Literal["prompt", "preview", "public_report"]


DEFAULT_STRUCTURED_RENDER_SCHEMA = StructuredRenderSchema()
# Prompt rendering may preserve transcript-shaped context that previews/reports hide.
PROMPT_STRUCTURED_RENDER_SCHEMA = StructuredRenderSchema(
    hidden_keys=frozenset({"raw", "debug", "diagnostics"}),
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
        "review_target_claim": 10,
        "patch_coverage": 20,
        "regression_status": 30,
        "resolution_next_step": 40,
        "validation_level": 50,
        "changed_files": 60,
        "patch_findings": 70,
        "verification_findings": 80,
        "residual_risks": 90,
    },
)
PREVIEW_STRUCTURED_RENDER_SCHEMA = DEFAULT_STRUCTURED_RENDER_SCHEMA
PUBLIC_REPORT_STRUCTURED_RENDER_SCHEMA = DEFAULT_STRUCTURED_RENDER_SCHEMA

_SCHEMA_BY_PROFILE: Mapping[StructuredRenderProfile, StructuredRenderSchema] = {
    "prompt": PROMPT_STRUCTURED_RENDER_SCHEMA,
    "preview": PREVIEW_STRUCTURED_RENDER_SCHEMA,
    "public_report": PUBLIC_REPORT_STRUCTURED_RENDER_SCHEMA,
}


def schema_for_profile(profile: StructuredRenderProfile) -> StructuredRenderSchema:
    return _SCHEMA_BY_PROFILE[profile]


def _humanize_key(key: Any, schema: StructuredRenderSchema) -> str:
    text = compact_plain_text(key)
    if not text:
        return "Value"
    return schema.key_labels.get(
        text, text.replace("_", " ").replace("-", " ").capitalize()
    )


def _is_empty_render_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, Mapping | Sequence | set):
        return len(value) == 0
    return False


def _is_ordered_sequence(value: Any) -> bool:
    return isinstance(value, Sequence) and not isinstance(value, str | bytes)


def _renderable_items(value: Any) -> list[Any]:
    if not _is_ordered_sequence(value):
        return []
    return [item for item in value if not _is_empty_render_value(item)]


def _looks_like_short_scalar(value: Any) -> bool:
    if isinstance(value, bool | int | float):
        return True
    if not isinstance(value, str):
        return False
    text = compact_plain_text(value)
    return bool(text) and "\n" not in value and len(text) <= 80


def _looks_like_path(value: str) -> bool:
    text = compact_plain_text(value)
    return "/" in text or text.startswith(".") or "\\" in text


def _ordered_items(
    mapping: Mapping[str, Any], schema: StructuredRenderSchema
) -> list[tuple[str, Any]]:
    return sorted(
        mapping.items(),
        key=lambda item: (schema.field_order.get(item[0], 1_000_000), item[0]),
    )


def _dict_anchor(value: Mapping[str, Any], schema: StructuredRenderSchema) -> str:
    for key in schema.anchor_keys:
        text = compact_plain_text(value.get(key))
        if not text:
            continue
        line = value.get("line")
        if isinstance(line, int):
            return inline_code(f"{text}:{line}")
        return inline_code(text)
    for key in schema.title_keys:
        text = compact_plain_text(value.get(key))
        if text:
            return md(t"{text}")
    return ""


def _dict_summary(value: Mapping[str, Any], schema: StructuredRenderSchema) -> str:
    for key in schema.summary_keys:
        text = compact_plain_text(value.get(key))
        if text:
            return md(t"{text}")
    return ""


def _render_scalar_line(label: str, value: Any, *, indent: int) -> str:
    prefix = "  " * indent
    rendered_label = markdown_text(label)
    if _looks_like_short_scalar(value):
        return f"{prefix}- {rendered_label}: {format_scalar(value)}"
    text = compact_plain_text(value)
    if text:
        return f"{prefix}- {rendered_label}: {md(t'{text}')}"
    return f"{prefix}- {rendered_label}: {format_scalar(value)}"


def _render_list_item(
    item: Any, *, indent: int, max_depth: int, schema: StructuredRenderSchema
) -> list[str]:
    prefix = "  " * indent
    if isinstance(item, Mapping):
        mapping = {str(key): value for key, value in item.items()}
        anchor = _dict_anchor(mapping, schema)
        summary = _dict_summary(mapping, schema)
        used_keys = {
            *schema.anchor_keys,
            "line",
            *schema.title_keys,
            *schema.summary_keys,
        }
        if anchor and summary and anchor != summary:
            lines = [f"{prefix}- {anchor}: {summary}"]
        elif anchor:
            lines = [f"{prefix}- {anchor}"]
        elif summary:
            lines = [f"{prefix}- {summary}"]
        else:
            lines = [f"{prefix}- Item"]
        nested = render_structured_markdown(
            {key: value for key, value in mapping.items() if key not in used_keys},
            indent=indent + 1,
            max_depth=max_depth,
            schema=schema,
        )
        lines.extend(nested)
        return lines
    if _is_ordered_sequence(item):
        lines = [f"{prefix}- Items:"]
        for child in _renderable_items(item):
            lines.extend(
                _render_list_item(
                    child,
                    indent=indent + 1,
                    max_depth=max_depth,
                    schema=schema,
                )
            )
        return lines
    text = compact_plain_text(item)
    if not text:
        return []
    if isinstance(item, str) and _looks_like_path(item):
        return [f"{prefix}- {inline_code(text)}"]
    return [f"{prefix}- {md(t'{text}')}"]


def render_structured_markdown(
    value: Mapping[str, Any],
    *,
    indent: int = 0,
    max_depth: int = 4,
    schema: StructuredRenderSchema | None = None,
    profile: StructuredRenderProfile = "preview",
) -> list[str]:
    """Render anonymous structured data into readable Markdown lines.

    The default schemas are intentionally small. Callers can pass a richer
    StructuredRenderSchema later without tying this renderer to contract JSON
    Schema.
    """
    if max_depth < 0:
        return []
    schema = schema or schema_for_profile(profile)
    lines: list[str] = []
    prefix = "  " * indent
    mapping = {str(key): item for key, item in value.items()}

    overview = compact_plain_text(mapping.get("overview"))
    if overview and indent == 0:
        lines.extend([md(t"{overview}"), ""])

    for key, item in _ordered_items(mapping, schema):
        if key in schema.hidden_keys or (indent == 0 and key == "overview"):
            continue
        if _is_empty_render_value(item):
            continue
        label = _humanize_key(key, schema)
        if isinstance(item, Mapping):
            nested = render_structured_markdown(
                {
                    str(child_key): child_value
                    for child_key, child_value in item.items()
                },
                indent=indent + 1,
                max_depth=max_depth - 1,
                schema=schema,
            )
            if not nested:
                continue
            if lines and lines[-1] != "":
                lines.append("")
            lines.extend([f"{prefix}{markdown_text(label)}:", "", *nested])
            continue
        if _is_ordered_sequence(item):
            items = _renderable_items(item)
            if not items:
                continue
            if indent > 0:
                lines.append(f"{prefix}- {markdown_text(label)}:")
                for child in items:
                    lines.extend(
                        _render_list_item(
                            child,
                            indent=indent + 1,
                            max_depth=max_depth - 1,
                            schema=schema,
                        )
                    )
                continue
            if lines and lines[-1] != "":
                lines.append("")
            lines.extend([f"{prefix}{markdown_text(label)}:", ""])
            for child in items:
                lines.extend(
                    _render_list_item(
                        child, indent=indent, max_depth=max_depth - 1, schema=schema
                    )
                )
            continue
        lines.append(_render_scalar_line(label, item, indent=indent))

    while lines and lines[-1] == "":
        lines.pop()
    return lines


def render_structured_markdown_section(
    title: str,
    value: Mapping[str, Any],
    *,
    profile: StructuredRenderProfile = "preview",
) -> str:
    lines = [
        f"# {md(t'{title}')}",
        "",
        *render_structured_markdown(value, profile=profile),
    ]
    return "\n".join(lines).rstrip()
