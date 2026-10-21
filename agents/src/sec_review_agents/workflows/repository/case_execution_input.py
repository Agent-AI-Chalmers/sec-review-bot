import hashlib
from collections.abc import Mapping
from pathlib import Path
from typing import Any, NotRequired, TypedDict

from sec_review_agents.utils.markdown import (
    bullet_section,
    heading,
    inline_code,
    markdown_section,
)
from sec_review_agents.utils.paths_ignore import (
    matches_paths_ignore,
    normalize_paths_ignore,
)
from sec_review_agents.workflows.review_intent import TestChangesPolicy

# A deletion case is not a candidate: it is produced from the window's own file list and handed
# straight to the analyzer. It carries no anchor, because the file it names is already gone.
DELETION_CASE_ORIGIN = "deleted-file"
DELETION_CASE_CATEGORY = "deleted-file"
# Beyond this many deleted files the window is a bulk removal, not a change anyone reviews. The
# caller chose the window, so an oversized one is the caller's mistake; the system answers by
# skipping deletion review for the whole window rather than splitting it into pieces that would
# look reviewed. Ordinary triaged cases still run.
MAX_DELETED_FILES = 200


class RepositoryCaseExecutionInput(TypedDict):
    case_id: str
    review_input: str
    workspace_snapshot_tar_path: str
    history_path: str
    scan_mode: str
    incremental_window_path: str | None
    test_changes: TestChangesPolicy
    setup_declaration_content: NotRequired[str | None]


def prepare_case_execution_input(
    *,
    workspace_snapshot_tar_path: Path,
    history_path: Path,
    incremental_window_path: Path | None,
    scan_mode: str,
    case: Mapping[str, Any],
    test_changes: TestChangesPolicy,
    setup_declaration_content: str | None = None,
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
        "test_changes": test_changes,
        "setup_declaration_content": setup_declaration_content,
    }
    return case_execution_input


def window_deletion_summary(
    *,
    scan_scope: Mapping[str, Any],
    scan_mode: str,
) -> dict[str, Any]:
    """Summarize what this window deleted and whether review covers it.

    The answer belongs to the scan, not to a case: the window decided it before discovery or triage
    ran. It uses the same path rules as the case builder, so the two cannot disagree about which
    windows are reviewed.
    """
    deleted_file_count = (
        0 if scan_mode != "incremental" else len(_deleted_paths_for_review(scan_scope))
    )
    return {
        "deleted_file_count": deleted_file_count,
        "deletion_review_skipped": deleted_file_count > MAX_DELETED_FILES,
    }


def _deleted_paths_for_review(scan_scope: Mapping[str, Any]) -> list[str]:
    """The window's deleted paths that review covers, in a stable order.

    The same ignore rules discovery applies to changed files, for the same reasons: a repository
    excludes vendored or generated trees from review.
    """
    raw_paths_ignore = scan_scope.get("paths_ignore")
    paths_ignore = normalize_paths_ignore(
        raw_paths_ignore if isinstance(raw_paths_ignore, list) else [],
        source="Repository deletion cases",
    )
    return sorted(
        {
            normalized_path
            for item in scan_scope.get("incremental_changed_files") or []
            if isinstance(item, Mapping)
            and str(item.get("status") or "").strip().lower() == "deleted"
            and str(item.get("path") or "").strip()
            for normalized_path in [str(item.get("path") or "").strip()]
            if not matches_paths_ignore(Path(normalized_path), paths_ignore)
        }
    )


def deleted_repository_cases(
    *,
    scan_scope: Mapping[str, Any],
    base_sha: str,
    head_sha: str,
) -> list[dict[str, Any]]:
    """Build one deletion case per directory that lost files in this window.

    A deleted file leaves nothing in the current tree, so no single-file scan can reach it: the
    protection it carried is simply absent, and absence has no line to look at. These cases are
    produced deterministically from the window and go straight to the analyzer, which is the only
    stage holding the diff, the history, and the current callers at once.

    The case boundary is the nearest parent directory. Files removed together from one directory
    usually belong to one mechanism -- a middleware and the policy beside it -- so they are better
    analysed as a unit than one at a time, which would make the analyzer re-read the same callers
    for each file and hide that the files went together. A directory is a boundary the repository
    chose, not a number this code invents.

    A window over the size limit yields no cases at all. That the window was too large is reported
    by the scan (deletion_review_skipped in the result), not here: nothing in this window is
    reviewable deletion-wise, so there is no case to attach the fact to.
    """
    if window_deletion_summary(scan_scope=scan_scope, scan_mode="incremental")[
        "deletion_review_skipped"
    ]:
        return []
    by_directory: dict[str, list[str]] = {}
    for path in _deleted_paths_for_review(scan_scope):
        by_directory.setdefault(Path(path).parent.as_posix(), []).append(path)
    return [
        {
            "case_id": f"deletion-{_deletion_case_slug(directory)}",
            "category": DELETION_CASE_CATEGORY,
            "summary": (
                f"These files were deleted from {directory} by this window and may have "
                "carried security boundaries: " + ", ".join(paths)
            ),
            "evidence": [],
            "member_candidate_ids": [],
            "anchor_locations": [],
            # Read by build_review_input. No discovery or triage stage ever sees this case.
            "origin": DELETION_CASE_ORIGIN,
            "deleted_paths": paths,
            "base_sha": base_sha,
            "head_sha": head_sha,
        }
        for directory, paths in sorted(by_directory.items())
    ]


def _deletion_case_slug(directory: str) -> str:
    """Turn a directory into a readable, collision-free case id fragment.

    A readable substitution alone cannot be unique: "/" and ":" are both legal in a Unix path, and
    a root-level "." needs its own spelling, so two different directories can print the same way.
    The digest is what makes the id injective; the readable part is what keeps the id nameable.
    """
    readable = directory.replace("/", ":").replace(".", "_") or "root"
    digest = hashlib.sha1(directory.encode("utf-8")).hexdigest()[:8]
    return f"{readable}-{digest}"


def _deletion_section(case: Mapping[str, Any]) -> str:
    """Render a deletion case for the analyzer.

    The case quotes no code on purpose: the deleted content is not in the workspace, and inventing
    an anchor for it would claim a verification that cannot happen. It names the paths, points at
    the two places that do hold the content, and says what a deletion can mean, so the analysis
    starts from the right question instead of re-deriving why the case exists.
    """
    deleted_paths = [
        str(path).strip()
        for path in case.get("deleted_paths") or []
        if str(path).strip()
    ]
    base_sha = inline_code(str(case.get("base_sha") or "?"))
    head_sha = inline_code(str(case.get("head_sha") or "?"))
    reading_hint = (
        f"Window {base_sha}..{head_sha}. Read what these files contained from "
        + "`/incremental-window/incremental.patch`"
        + ", or with git in "
        + "`/workspace`"
        + "."
    )
    return "\n".join(
        [
            heading("Deletion Case", level=2),
            "",
            (
                "This case exists because the window deleted these files. They are not in the "
                "current tree, so nothing can be read at their paths: the deletion is the change "
                "under review."
            ),
            "",
            *[f"- {inline_code(path)}" for path in deleted_paths],
            "",
            reading_hint,
            "",
            heading("Why This Case Exists", level=3),
            "",
            (
                "Removing a protection leaves no trace on a line of the current code: the "
                "problem is that something is absent. A single-file scan judges a file by what "
                "it currently contains, so it cannot see that a check used to be there."
            ),
            "",
            "Deletions that usually carry security weight:",
            "",
            (
                "- A shared guard removed while its consumers are untouched: a unified auth "
                "middleware deleted while every route file stays unchanged, or a shared "
                "validation helper deleted while its call sites still call it."
            ),
            (
                "- A rule or trust material removed while the code it governed is unchanged: a "
                "denylist, certificate, or policy file deleted while the code that depended on "
                "it looks exactly as before."
            ),
            "",
            (
                "For each deleted file, find what it enforced and what still relies on it. "
                "Read the callers and the surrounding code, not the deletion alone."
            ),
            "",
            (
                "Report a finding only when the removal gave up a security boundary that "
                "current code depends on, and name the code that now lacks it. When nothing "
                "depends on the removed behavior, reject the case."
            ),
        ]
    )


def build_review_input(*, case: Mapping[str, Any], scan_mode: str) -> str:
    """Compile repository-scope case data into the opaque review-stage input."""
    if str(case.get("origin") or "") == DELETION_CASE_ORIGIN:
        return _deletion_section(case)
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
