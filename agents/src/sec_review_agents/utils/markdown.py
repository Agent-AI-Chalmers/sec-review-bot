import difflib
import json
from collections.abc import Callable
from pathlib import Path
from string.templatelib import Template, convert
from typing import Any


def heading(title: str, *, level: int = 1) -> str:
    marker = "#" * max(1, min(level, 6))
    resolved_title = str(title).strip() or "Untitled"
    return f"{marker} {markdown_text(resolved_title)}"


def code_block(language: str, content: str) -> str:
    fence = "```"
    text = str(content)
    while fence in text:
        fence += "`"
    return "\n".join([f"{fence}{language}", text, fence])


def format_scalar(value: Any) -> str:
    if value is None:
        return "`null`"
    if isinstance(value, bool):
        return "`true`" if value else "`false`"
    if isinstance(value, (int, float)):
        return md(t"`{value}`")
    text = str(value).strip()
    if not text:
        return '`""`'
    return md(t"`{text}`")


def plain_text(value: Any, fallback: str = "") -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    return fallback


def compact_plain_text(value: Any, fallback: str = "") -> str:
    normalized = " ".join(plain_text(value, fallback).split())
    return normalized or fallback


def inline_code(value: Any, fallback: str = "") -> str:
    """Format a short token/path/status as markdown inline code."""
    normalized = compact_plain_text(value, fallback)
    return md(t"`{normalized}`") if normalized else ""


def markdown_text(value: Any) -> str:
    return str(value).replace("`", "\\`")


def render_template(
    template: Template,
    *,
    formatter: Callable[[Any], str] = str,
) -> str:
    parts: list[str] = []
    for index, text in enumerate(template.strings):
        parts.append(text)
        if index >= len(template.interpolations):
            continue
        interpolation = template.interpolations[index]
        value = convert(interpolation.value, interpolation.conversion)
        if interpolation.format_spec:
            value = format(value, interpolation.format_spec)
        parts.append(formatter(value))
    return "".join(parts)


def md(template: Template) -> str:
    """Render a t-string with markdown escaping for interpolated values."""
    return render_template(template, formatter=markdown_text)


def dedupe_text_items(items: list[Any], limit: int | None = None) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        normalized = compact_plain_text(item)
        key = normalized.lower()
        if not normalized or key in seen:
            continue
        seen.add(key)
        result.append(normalized)
        if limit is not None and len(result) >= limit:
            break
    return result


def folded_block(summary: str, lines: list[str]) -> list[str]:
    if not any(line for line in lines):
        return []
    return [
        "<details>",
        md(t"<summary>{summary}</summary>"),
        "",
        *lines,
        "",
        "</details>",
    ]


def scalar_section(title: str, mapping: dict[str, Any]) -> str:
    lines = [heading(title), ""]
    for key, value in mapping.items():
        formatted_value = format_scalar(value)
        lines.append(md(t"- `{key}`: ") + formatted_value)
    return "\n".join(lines)


def markdown_section(title: str, body: str, *, level: int = 1) -> str:
    text = body.strip() if isinstance(body, str) and body.strip() else "_(empty)_"
    return "\n".join([heading(title, level=level), "", text])


def bullet_section(
    title: str,
    values: list[Any],
    *,
    level: int = 1,
    empty_text: str = "_(none)_",
) -> str:
    lines = [heading(title, level=level), ""]
    lines.extend(bullets(values, empty_text=empty_text))
    return "\n".join(lines)


def json_section(title: str, payload: Any) -> str:
    return "\n".join(
        [
            heading(title),
            "",
            code_block("json", json.dumps(payload, indent=2)),
        ]
    )


def bullets(values: list[Any], *, empty_text: str = "_(none)_") -> list[str]:
    normalized = [str(item).strip() for item in values if str(item).strip()]
    if not normalized:
        return [empty_text]
    return [md(t"- {item}") for item in normalized]


def write_markdown(path: Path, title: str, body_lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"{heading(title)}\n\n" + "\n".join(body_lines).rstrip() + "\n",
        encoding="utf-8",
    )


def unified_diff_text(
    *,
    before: str,
    after: str,
    relative_path: str,
) -> str:
    diff_lines = list(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{relative_path}",
            tofile=f"b/{relative_path}",
        )
    )
    if diff_lines and not diff_lines[-1].endswith("\n"):
        diff_lines[-1] += "\n"
    return "".join(diff_lines)
