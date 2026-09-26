"""Synthesize patches for combined deliveries."""

import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from sec_review_agents.agents.patch_synthesis.agent import (
    PATCH_SYNTHESIS_AGENT_NAME,
    create_patch_synthesis_agent_graph,
)
from sec_review_agents.agents.patch_synthesis.backend import (
    create_patch_synthesis_backend,
)
from sec_review_agents.agents.patch_synthesis.prompts import (
    build_patch_synthesis_system_prompt,
    build_patch_synthesis_user_prompt,
)
from sec_review_agents.delivery_stages.model import (
    DeliveryEntry,
)
from sec_review_agents.run_artifacts.stage import reset_stage_attempt_artifacts
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.utils.markdown import inline_code, md
from sec_review_agents.workspace.file_changes import FileChange
from sec_review_agents.workspace.patches import (
    normalize_declared_changed_files,
    persist_workspace_patch,
)
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar


def _file_overlap_summary(
    case_payloads: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    cases_by_file: dict[str, list[str]] = {}
    files_by_case: dict[str, list[str]] = {}
    for case_payload in case_payloads:
        case_id = str(case_payload.get("case_id") or "").strip()
        if not case_id:
            continue
        changed_files: list[str] = []
        seen_paths: set[str] = set()
        for path in case_payload.get("mitigator_changed_files") or []:
            if path in seen_paths:
                continue
            seen_paths.add(path)
            changed_files.append(path)
        files_by_case[case_id] = changed_files
        for path in changed_files:
            cases_by_file.setdefault(path, []).append(case_id)

    overlapping_files = [
        {
            "path": path,
            "case_ids": case_ids,
            "case_count": len(case_ids),
        }
        for path, case_ids in sorted(cases_by_file.items())
        if len(case_ids) > 1
    ]
    return {
        "files_by_case": files_by_case,
        "overlapping_files": overlapping_files,
        "has_overlaps": bool(overlapping_files),
    }


def render_delivery_patch_synthesis_brief(
    *,
    delivery_entry: DeliveryEntry,
    case_items: Sequence[Mapping[str, Any]],
    case_ids: list[str] | None = None,
) -> str:
    resolved_case_ids = case_ids or [item["case_id"] for item in case_items]
    case_payloads = list(case_items)
    overlap = _file_overlap_summary(case_payloads)
    lines = [
        "# Patch Synthesis Brief",
        "",
        md(t"- Reason: {delivery_entry.get('reason') or 'unspecified'}"),
        "- Case IDs: "
        + ", ".join(inline_code(case_id) for case_id in resolved_case_ids),
    ]

    lines.extend(["", "## Overlapping Case Files"])
    overlapping_files = overlap.get("overlapping_files") or []
    if overlapping_files:
        for item in overlapping_files:
            overlap_case_ids = ", ".join(
                inline_code(case_id) for case_id in item.get("case_ids") or []
            )
            path = inline_code(item.get("path"))
            lines.append(f"- {path}: {overlap_case_ids}")
    else:
        lines.append("- No case changed-file overlaps were reported.")

    lines.extend(["", "## Cases"])
    for case in case_payloads:
        case_id = str(case.get("case_id") or "")
        changed_files = (
            ", ".join(
                inline_code(path) for path in case.get("mitigator_changed_files") or []
            )
            or "none"
        )
        lines.extend(
            [
                f"### {inline_code(case_id)}",
                "",
                f"- Changed files: {changed_files}",
                "",
                "#### Reference Patch",
            ]
        )
        patch_text = str(case.get("mitigator_patch_diff") or "")
        if patch_text:
            lines.extend(["", "```diff", patch_text.rstrip("\n"), "```", ""])
        else:
            lines.extend(["- Patch unavailable.", ""])

    return "\n".join(lines).rstrip() + "\n"


def build_delivery_patch_synthesis_user_prompt(
    *,
    delivery_entry: DeliveryEntry,
    case_items: Sequence[Mapping[str, Any]],
    case_ids: list[str],
) -> str:
    return build_patch_synthesis_user_prompt(
        render_delivery_patch_synthesis_brief(
            delivery_entry=delivery_entry,
            case_items=case_items,
            case_ids=case_ids,
        )
    )


def _patch_synthesis_result(
    *,
    status: str,
    error: str | None,
    patch_path: str | None,
    changed_files: list[str],
    patch_diff: str = "",
    file_changes: list[FileChange] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "error": error,
        "patch_path": patch_path,
        "patch_diff": patch_diff,
        "changed_files": changed_files,
        "file_changes": file_changes or [],
    }


async def synthesize_combined_delivery_patch(
    *,
    baseline_snapshot_tar_path: Path,
    patch_synthesis_root: Path,
    delivery_entry: DeliveryEntry,
    case_items: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    delivery_id = delivery_entry["delivery_id"]
    if not delivery_id:
        return _patch_synthesis_result(
            status="invalid-input",
            error="Missing delivery_id for combined patch synthesis.",
            patch_path=None,
            changed_files=[],
        )

    if not baseline_snapshot_tar_path.exists():
        return _patch_synthesis_result(
            status="invalid-input",
            error=(
                "Missing patch-synthesis baseline snapshot at "
                f"{baseline_snapshot_tar_path}."
            ),
            patch_path=None,
            changed_files=[],
        )

    case_ids = [item["case_id"] for item in case_items]
    user_prompt = build_delivery_patch_synthesis_user_prompt(
        delivery_entry=delivery_entry,
        case_items=case_items,
        case_ids=case_ids,
    )
    system_prompt = build_patch_synthesis_system_prompt()
    delivery_artifacts_root = patch_synthesis_root / delivery_id

    with tempfile.TemporaryDirectory(
        prefix=f"sec-review-patch-synthesis-{delivery_id}-"
    ) as tempdir:
        reset_stage_attempt_artifacts(
            delivery_artifacts_root,
            filenames=("transcript.json", "workspace.patch"),
        )
        workspace_path = Path(tempdir)
        restore_workspace_from_snapshot_tar(
            tar_path=baseline_snapshot_tar_path,
            destination_path=workspace_path,
        )
        backend = create_patch_synthesis_backend(
            workspace_root_path=workspace_path,
            workspace_writable=True,
        )
        async with amanaged_backend(backend):
            agent = await create_patch_synthesis_agent_graph(
                backend=backend,
                workspace_root_path=workspace_path,
                baseline_snapshot_tar_path=baseline_snapshot_tar_path,
                system_prompt=system_prompt,
            )
            structured_payload = await invoke_agent_runtime_graph(
                agent=agent,
                agent_name=PATCH_SYNTHESIS_AGENT_NAME,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                transcript_paths=(delivery_artifacts_root / "transcript.json",),
            )

        raw_declared_changed_files = structured_payload.get("declared_changed_files")
        if not isinstance(raw_declared_changed_files, list):
            raise ValueError(
                "Patch synthesis agent output requires declared_changed_files."
            )
        declared_changed_files = normalize_declared_changed_files(
            raw_declared_changed_files
        )
        if not declared_changed_files:
            return _patch_synthesis_result(
                status="no-changes",
                error="Patch synthesis agent declared no delivery file changes.",
                patch_path=None,
                changed_files=[],
            )
        patch_path = delivery_artifacts_root / "workspace.patch"
        patch_path.parent.mkdir(parents=True, exist_ok=True)
        patch_artifact = persist_workspace_patch(
            workspace_path,
            patch_root_path=patch_path.parent,
            include_paths=declared_changed_files,
        )
        if not patch_artifact["file_changes"]:
            return _patch_synthesis_result(
                status="no-changes",
                error="Patch synthesis agent produced no declared delivery file changes.",
                patch_path=None,
                changed_files=[],
            )
        return _patch_synthesis_result(
            status="ready",
            error=None,
            patch_path=patch_artifact["patch_path"],
            patch_diff=patch_artifact["patch_diff"],
            changed_files=patch_artifact["changed_files"],
            file_changes=patch_artifact["file_changes"],
        )
