from collections.abc import Mapping
from typing import Any

from sec_review_agents.resources.loader import join_prompt_sections
from sec_review_agents.utils.markdown import (
    code_block,
    json_section,
)

REPOSITORY_DISCOVERY_INTRO = "\n".join(
    [
        "# Task",
        "",
        "Perform local-scope security discovery for this group of repository files.",
    ]
)


def build_repository_discovery_system_prompt() -> str:
    return join_prompt_sections(
        [
            "discovery/system.md",
        ]
    )


def _render_line_numbered_source(content: str) -> str:
    lines = content.splitlines()
    return "\n".join(
        f"{line_no:>6}\t{line_text}" for line_no, line_text in enumerate(lines, start=1)
    )


def build_repository_discovery_user_prompt(
    *,
    chunk: Mapping[str, Any],
    scan_virtual_path: str | None = None,
    sources: Mapping[str, str],
) -> str:
    resolved_scan_path = str(
        scan_virtual_path or chunk.get("chunk_id") or "discovery-chunk"
    ).strip()
    if not resolved_scan_path:
        raise ValueError(
            "Discovery prompt requires scan_virtual_path or chunk.chunk_id."
        )
    if not resolved_scan_path.startswith("/"):
        resolved_scan_path = f"/{resolved_scan_path}"

    rendered_sources: list[dict[str, Any]] = []
    source_sections: list[str] = []
    for entry in chunk.get("entries") or []:
        if not isinstance(entry, Mapping):
            continue
        path = str(entry.get("path") or "").strip()
        if not path:
            continue
        content = sources.get(path)
        if content is None:
            continue
        rendered_sources.append(
            {
                "path": path,
                "language": entry.get("language"),
                "size_bytes": entry.get("size_bytes"),
                "inline_source_provided": True,
            }
        )
        source_sections.extend(
            [
                "",
                f"# Inline Source: /{path}",
                "",
                code_block("text", _render_line_numbered_source(content)),
            ]
        )

    sections = [
        REPOSITORY_DISCOVERY_INTRO,
        "",
        json_section(
            "Scan Target",
            {
                "chunk_id": chunk["chunk_id"],
                "scan_path": resolved_scan_path,
                "files": rendered_sources,
            },
        ),
        "",
        "# Output Rules",
        "",
        "- Every location must include `file`, using one of the provided repository-relative paths.",
        "- Evidence snippets must be copied verbatim from one of the provided files.",
    ]
    sections.extend(source_sections)
    return "\n".join(sections)
