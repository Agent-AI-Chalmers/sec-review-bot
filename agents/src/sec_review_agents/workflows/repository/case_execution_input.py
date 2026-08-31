from collections.abc import Mapping
from pathlib import Path
from typing import Any, TypedDict

from sec_review_agents.utils.markdown import (
    bullet_section,
    heading,
    inline_code,
    markdown_section,
)
from sec_review_agents.workflows.review_intent import RepairMode


class RepositoryCaseExecutionInput(TypedDict):
    case_id: str
    review_input: str
    workspace_snapshot_tar_path: str
    history_path: str
    scan_mode: str
    incremental_window_path: str | None
    repair_mode: RepairMode


def prepare_case_execution_input(
    *,
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    incremental_window_path: Path | None,
    scan_mode: str,
    case: Mapping[str, Any],
    repair_mode: RepairMode,
) -> RepositoryCaseExecutionInput:
    case_id = str(case.get("case_id") or "").strip()
    if not case_id:
        raise ValueError("Repository case is missing case_id.")
    # Repository owns the raw triage-case adapter. This function compiles it into
    # the runtime payload required by repository case execution.
    review_input = build_review_input(
        case=case,
        scan_mode=scan_mode,
    )
    case_execution_input: RepositoryCaseExecutionInput = {
        "case_id": case_id,
        "review_input": review_input,
        "workspace_snapshot_tar_path": str(workspace_snapshot_tar_path),
        "history_path": str(history_path),
        "scan_mode": scan_mode,
        "incremental_window_path": (
            str(incremental_window_path)
            if incremental_window_path is not None
            else None
        ),
        "repair_mode": repair_mode,
    }
    return case_execution_input


def build_review_input(*, case: Mapping[str, Any], scan_mode: str) -> str:
    """Compile repository-scope case data into the opaque review-stage input."""
    sections = [
        markdown_section("Review Input", _case_overview(case)),
        "",
        bullet_section(
            "Candidate Evidence",
            _normalized_text_items(case["evidence"]),
            level=2,
        ),
        "",
        _anchor_locations_section(case["anchor_locations"]),
    ]
    if scan_mode == "incremental":
        sections.extend(
            [
                "",
                "## Incremental Evidence",
                "",
                "Use these files only if the case depends on changed-code context:",
                "",
                "- Changed files: `/incremental-window/changed-files.json`",
                "- Incremental patch: `/incremental-window/incremental.patch`",
                "- Scan window: `/history/scan-window.json`",
                "- Commits: `/history/commits.json`",
            ]
        )
    return "\n".join(sections).strip()


def _case_overview(case: Mapping[str, Any]) -> str:
    lines: list[str] = []
    for value in (
        case["category"],
        case["summary"],
    ):
        text = str(value or "").strip()
        if text and text not in lines:
            lines.append(text)
    return "\n\n".join(lines) if lines else "_(no case overview supplied)_"


def _normalized_text_items(items: list[Any]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        normalized.append(text)
    return normalized


def _render_anchor_locations(locations: list[Any]) -> list[str]:
    rendered: list[str] = []
    seen: set[str] = set()
    for item in locations:
        if not isinstance(item, dict):
            continue
        file_path = str(item.get("file") or "").strip().lstrip("/")
        if not file_path:
            continue
        line = item.get("line")
        label = str(item.get("label") or "").strip()
        anchor = (
            inline_code(f"{file_path}:{line}")
            if isinstance(line, int)
            else inline_code(file_path)
        )
        text = f"{anchor}: {label}" if label else anchor
        if text in seen:
            continue
        seen.add(text)
        rendered.append(text)
    return rendered


def _anchor_locations_section(locations: list[Any]) -> str:
    anchors = _render_anchor_locations(locations)
    lines = [heading("Candidate Anchors", level=2), ""]
    if not anchors:
        lines.append("_(none)_")
    else:
        lines.extend(f"- {anchor}" for anchor in anchors)
    return "\n".join(lines)


__all__ = [
    "RepositoryCaseExecutionInput",
    "build_review_input",
    "prepare_case_execution_input",
]
