import re
from pathlib import Path
from typing import Any

from sec_review_agents.cli.local_previewing.shared import (
    as_dict,
    as_list,
    final_patch_block_from_diff,
    render_analysis_narratives,
    render_mitigation_preview_lines,
    render_verification_preview_lines,
)
from sec_review_agents.utils.markdown import (
    compact_plain_text,
    folded_block,
    inline_code,
    md,
    unified_diff_text,
    write_markdown,
)
from sec_review_agents.utils.paths import required_path

LOCAL_PREVIEW_NOTICE = (
    "_Local developer preview only; the GitHub App may publish different final "
    "title/body text._"
)


def _parse_cvss_base_vector(vector: Any) -> dict[str, str]:
    parsed: dict[str, str] = {}
    raw = str(vector or "").strip()
    if not raw:
        return parsed
    for part in raw.split("/"):
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        if key:
            parsed[key] = value
    return parsed


def _format_cvss_key_metrics(vector: Any) -> str:
    parsed = _parse_cvss_base_vector(vector)
    return ", ".join(
        f"{key}={parsed.get(key, '?')}" for key in ("AV", "AC", "AT", "PR", "UI")
    )


def _render_cvss_scoring_section(cvss: dict[str, Any]) -> list[str]:
    outcome = compact_plain_text(cvss.get("outcome"))
    overview = str(cvss.get("overview") or "No CVSS scoring overview was recorded.")
    if outcome == "not-scored":
        return [
            "#### CVSS",
            "",
            "- Outcome: `not-scored`",
            "",
            str(
                cvss.get("not_scored_reason")
                or "Current case is not independently CVSS-scoreable."
            ),
            "",
        ]
    if outcome and outcome != "scored":
        return [
            "#### CVSS",
            "",
            overview,
            "",
            f"- Outcome: {inline_code(outcome)}",
            "",
        ]
    return [
        "#### CVSS",
        "",
        overview,
        "",
        f"- Base score: {inline_code(cvss.get('base_score', 'n/a'))} ({inline_code(cvss.get('severity'), 'unknown')})",
        f"- Vector: {inline_code(cvss.get('vector'), 'unknown')}",
        f"- Key metrics: {inline_code(_format_cvss_key_metrics(cvss.get('vector')))}",
        "",
    ]


def _render_cvss_scoring_body(cvss: dict[str, Any]) -> list[str]:
    section = _render_cvss_scoring_section(cvss)
    if section[:2] == ["#### CVSS", ""]:
        return section[2:]
    return section


def _compact_summary(value: Any, *, max_chars: int = 140) -> str:
    text = compact_plain_text(value)
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _primary_file_for_delivery_title(delivery_artifact: dict[str, Any]) -> str:
    changed_files = _changed_files_for_delivery(delivery_artifact)
    return changed_files[0] if changed_files else ""


def _delivery_title_related_suffix(delivery_artifact: dict[str, Any]) -> str:
    case_count = len(as_list(delivery_artifact.get("case_ids")))
    if case_count <= 1:
        return ""
    related_count = case_count - 1
    plural = "" if related_count == 1 else "s"
    return f" (+{related_count} related case{plural})"


def _build_delivery_draft_pr_title(delivery_artifact: dict[str, Any]) -> str:
    delivery_id = compact_plain_text(delivery_artifact.get("delivery_id")) or "unknown"
    primary_file = _primary_file_for_delivery_title(delivery_artifact)
    suffix = _delivery_title_related_suffix(delivery_artifact)
    if primary_file:
        return f"[sec] Repository delivery {delivery_id} in {primary_file}{suffix}"
    return f"[sec] Repository delivery {delivery_id}{suffix}"


def _changed_files_for_delivery(delivery_artifact: dict[str, Any]) -> list[str]:
    changed_files = [
        item
        for item in (
            compact_plain_text(file_change.get("path"))
            for file_change in as_list(delivery_artifact.get("file_changes"))
            if isinstance(file_change, dict)
        )
        if item
    ]
    seen: set[str] = set()
    ordered: list[str] = []
    for item in changed_files:
        if item in seen:
            continue
        seen.add(item)
        ordered.append(item)
    return ordered


def _case_results_by_id(
    case_results: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for item in case_results:
        case_id = compact_plain_text(item.get("case_id"))
        if case_id and case_id not in indexed:
            indexed[case_id] = item
    return indexed


def _delivery_case_details(
    *,
    case_id: str,
    case_result: dict[str, Any],
) -> list[str]:
    review_record = as_dict(case_result.get("review_record"))
    analysis = as_dict(review_record.get("analysis"))
    mitigation = as_dict(review_record.get("mitigation"))
    verification = as_dict(review_record.get("verification"))
    cvss = as_dict(review_record.get("cvss"))
    case_summary = [
        f"- Analyzer verdict: {inline_code(analysis.get('verdict'), 'unknown')}",
        f"- Patch coverage: {inline_code(verification.get('patch_coverage'), 'unknown')}",
        f"- Regression status: {inline_code(verification.get('regression_status'), 'unknown')}",
        f"- Resolution next step: {inline_code(verification.get('resolution_next_step'), 'unknown')}",
    ]
    case_details = [
        f"### Case {inline_code(case_id)}",
        "",
        *case_summary,
        "",
        *folded_block(
            "Analysis",
            [
                str(analysis.get("overview") or "No analyzer overview was recorded."),
                "",
                *render_analysis_narratives(analysis.get("narratives")),
            ],
        ),
        *folded_block("CVSS", _render_cvss_scoring_body(cvss)),
        *folded_block(
            "Mitigation",
            render_mitigation_preview_lines(mitigation),
        ),
    ]
    case_details.extend(
        folded_block("Verification", render_verification_preview_lines(verification))
    )
    return folded_block(f"View case {case_id}", case_details)


def _build_delivery_draft_pr_body(
    *,
    delivery_artifact: dict[str, Any],
    case_results_by_id: dict[str, dict[str, Any]],
) -> str:
    case_ids = [
        compact_plain_text(item) for item in as_list(delivery_artifact.get("case_ids"))
    ]
    case_ids = [item for item in case_ids if item]
    changed_files = _changed_files_for_delivery(delivery_artifact)
    primary_case_id = case_ids[0] if case_ids else "unknown"
    case_count = len(case_ids)

    lines = [
        f"<!-- sec-review-bot-delivery-id: {delivery_artifact.get('delivery_id') or 'unknown'} -->",
        f"<!-- sec-review-bot-case-count: {int(case_count)} -->",
        f"<!-- sec-review-bot-primary-case-id: {primary_case_id} -->",
        "",
        f"This PR applies security mitigations for `{int(case_count)}` confirmed case(s).",
        "",
        "",
        "## Modified Files",
        "",
    ]

    if changed_files:
        lines.extend(f"- {inline_code(item)}" for item in changed_files)
    else:
        lines.append("- No modified files were recorded.")

    case_details = [
        detail
        for case_id in case_ids
        if (case_result := case_results_by_id.get(case_id)) is not None
        for detail in _delivery_case_details(case_id=case_id, case_result=case_result)
    ]
    if case_details:
        lines.extend(
            [
                "",
                "## Case Details",
                "",
                "_The following sections summarize case-level stage outputs. For combined deliveries, the final PR diff is authoritative._",
                "",
                *case_details,
            ]
        )
    elif case_ids:
        lines.extend(
            [
                "",
                "## Cases",
                "",
                "_For combined deliveries, the final PR diff is authoritative._",
                "",
            ]
        )
        lines.extend(f"- {inline_code(case_id)}" for case_id in case_ids)

    return "\n".join(lines)


def _blocked_confirmed_case_id(case_result: dict[str, Any]) -> str:
    return compact_plain_text(case_result.get("case_id")) or "unknown"


def _blocked_confirmed_case_title(
    *,
    case_id: str,
    analysis: dict[str, Any],
    cvss: dict[str, Any],
    verification: dict[str, Any],
) -> str:
    severity = compact_plain_text(cvss.get("severity"), "unscored")
    coverage = compact_plain_text(verification.get("patch_coverage"))
    overview = _compact_summary(analysis.get("overview"), max_chars=96)
    suffix = overview or "confirmed but not fully verified"
    return f"[{severity}] {case_id} - {suffix}{f' ({coverage})' if coverage else ''}"


def _reference_patch_block(patch_diff: Any) -> list[str]:
    patch = str(patch_diff or "").strip()
    if not patch:
        return []
    max_patch_chars = 12_000
    truncated = len(patch) > max_patch_chars
    visible_patch = (
        patch[:max_patch_chars].rstrip()
        + "\n\n[sec-review-agents: reference patch truncated for preview.]"
        if truncated
        else patch
    )
    return [
        "",
        "<details>",
        "<summary>Reference patch</summary>",
        "",
        "```diff",
        visible_patch,
        "```",
        "",
        "</details>",
    ]


def _is_blocked_confirmed_case(case_result: dict[str, Any]) -> bool:
    if compact_plain_text(case_result.get("disposition")) == "keep":
        return False
    review_record = as_dict(case_result.get("review_record"))
    analysis = as_dict(review_record.get("analysis"))
    return compact_plain_text(analysis.get("verdict")) in {
        "confirmed-defect",
        "confirmed-vulnerability",
        "plausible-risk",
    }


def _build_blocked_confirmed_cases_preview(
    case_results: list[dict[str, Any]],
) -> list[str]:
    blocks: list[str] = []
    for case_result in case_results:
        if not _is_blocked_confirmed_case(case_result):
            continue
        review_record = as_dict(case_result.get("review_record"))
        analysis = as_dict(review_record.get("analysis"))
        cvss = as_dict(review_record.get("cvss"))
        mitigation = as_dict(review_record.get("mitigation"))
        verification = as_dict(review_record.get("verification"))
        case_id = _blocked_confirmed_case_id(case_result)
        fallback_reason = compact_plain_text(
            case_result.get("reason"), "No verified fix was produced."
        )
        body = [
            *folded_block(
                "Analysis",
                [
                    compact_plain_text(analysis.get("overview"))
                    or "Analyzer confirmed this case, but no analysis overview was recorded.",
                    "",
                    *render_analysis_narratives(analysis.get("narratives")),
                ],
            ),
            *folded_block("CVSS", _render_cvss_scoring_body(cvss)),
            *folded_block(
                "Mitigation",
                [
                    *render_mitigation_preview_lines(
                        mitigation,
                        fallback=fallback_reason,
                    ),
                    *_reference_patch_block(mitigation.get("patch_diff")),
                ],
            ),
        ]
        body.extend(
            folded_block(
                "Verification",
                render_verification_preview_lines(
                    verification,
                    fallback=fallback_reason,
                ),
            )
        )
        blocks.extend(
            folded_block(
                _blocked_confirmed_case_title(
                    case_id=case_id,
                    analysis=analysis,
                    cvss=cvss,
                    verification=verification,
                ),
                body,
            )
        )
        blocks.append("")
    return blocks


def _workspace_root(local_root_path: object) -> Path | None:
    if isinstance(local_root_path, str) and local_root_path.strip():
        return Path(local_root_path) / "workspace"
    return None


def _decode_file_change_text(file_change: dict[str, Any]) -> str | None:
    if file_change.get("status") == "deleted":
        return ""
    if file_change.get("content_encoding") != "utf-8":
        return None
    content = file_change.get("content")
    if not isinstance(content, str):
        return None
    return content


def _read_baseline_text(workspace_root: Path | None, relative_path: str) -> str | None:
    if workspace_root is None:
        return ""
    path = workspace_root / relative_path
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except UnicodeDecodeError:
        return None


def _build_final_patch_preview(
    *,
    materialized_input: dict[str, Any],
    delivery_artifact: dict[str, Any],
) -> list[str]:
    workspace_root = _workspace_root(materialized_input.get("input_bundle_uri"))
    diff_parts: list[str] = []
    skipped_paths: list[str] = []
    for file_change in as_list(delivery_artifact.get("file_changes")):
        if not isinstance(file_change, dict):
            continue
        relative_path = str(file_change.get("path") or "").strip()
        if not relative_path:
            continue
        before = _read_baseline_text(workspace_root, relative_path)
        after = _decode_file_change_text(file_change)
        if before is None or after is None:
            skipped_paths.append(relative_path)
            continue
        diff_parts.append(
            unified_diff_text(
                before=before,
                after=after,
                relative_path=relative_path,
            )
        )
    return final_patch_block_from_diff(
        patch="".join(diff_parts),
        skipped_paths=skipped_paths,
    )


def _coordination_notes_for_preview_index(
    preview_items: list[dict[str, Any]],
) -> list[str]:
    by_file: dict[str, list[dict[str, Any]]] = {}
    for item in preview_items:
        for file_path in item.get("changed_files") or []:
            by_file.setdefault(str(file_path), []).append(item)

    notes: list[str] = []
    for file_path, items in sorted(by_file.items()):
        if len(items) < 2:
            continue
        links = ", ".join(
            f"[{inline_code(item['delivery_id'])}](./{Path(str(item['preview_relative_path'])).name})"
            for item in sorted(
                items, key=lambda value: str(value.get("delivery_id") or "")
            )
        )
        notes.append(
            f"- Shared modified file {inline_code(file_path)}: {links}. "
            "These previews touch the same file; review publish order if publishing them together."
        )
    return notes


def _build_repository_preview_index_readme(
    preview_items: list[dict[str, Any]],
    blocked_confirmed_preview: dict[str, Any] | None = None,
) -> list[str]:
    lines = [
        "# Repository Delivery Previews",
        "",
        "Local-only preview files for publishable repository delivery artifacts.",
        "These files are generated for local inspection and are not part of the runner or app contract.",
        "",
    ]
    if blocked_confirmed_preview:
        lines.extend(
            [
                "## Blocked Confirmed Cases",
                "",
                f"- [{blocked_confirmed_preview['title']}](./{Path(str(blocked_confirmed_preview['preview_relative_path'])).name})",
                "",
            ]
        )

    if not preview_items:
        lines.append("- No publishable delivery artifacts were available for preview.")
        return lines

    for item in preview_items:
        delivery_id = inline_code(item["delivery_id"])
        raw_title = item["title"]
        title = md(t"{raw_title}")
        preview_name = Path(str(item["preview_relative_path"])).name
        lines.append(f"- {delivery_id}: [{title}](./{preview_name})")
    coordination_notes = _coordination_notes_for_preview_index(preview_items)
    if coordination_notes:
        lines.extend(
            [
                "",
                "## Coordination Notes",
                "",
                *coordination_notes,
            ]
        )
    return lines


def _slug(value: Any) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("-")
    return slug or "delivery"


def _publishable_delivery_artifacts(
    deliveries: list[Any],
) -> list[tuple[dict[str, Any], str]]:
    artifacts: list[tuple[dict[str, Any], str]] = []
    for artifact in as_list(deliveries):
        if not isinstance(artifact, dict):
            continue
        delivery_id = str(artifact.get("delivery_id") or "delivery")
        artifacts.append((artifact, delivery_id))
    return artifacts


def write_repository_draft_pr_previews(
    *,
    materialized_input: dict[str, Any],
    deliveries: list[Any],
    case_results: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    output_dir = (
        required_path(
            materialized_input.get("input_bundle_uri"),
            label="input_bundle_uri",
        )
        / "artifacts"
        / "previews"
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    preview_items: list[dict[str, Any]] = []
    indexed_case_results = _case_results_by_id(case_results or [])
    for artifact, delivery_id in _publishable_delivery_artifacts(deliveries):
        filename = f"{_slug(delivery_id)}.md"
        title = _build_delivery_draft_pr_title(artifact)
        body = _build_delivery_draft_pr_body(
            delivery_artifact=artifact,
            case_results_by_id=indexed_case_results,
        )
        write_markdown(
            output_dir / filename,
            title,
            [
                LOCAL_PREVIEW_NOTICE,
                "",
                body,
                "",
                *_build_final_patch_preview(
                    materialized_input=materialized_input,
                    delivery_artifact=artifact,
                ),
            ],
        )
        preview_items.append(
            {
                "delivery_id": delivery_id,
                "title": title,
                "preview_relative_path": f"previews/{filename}",
                "changed_files": _changed_files_for_delivery(artifact),
            }
        )

    blocked_confirmed_lines = _build_blocked_confirmed_cases_preview(case_results or [])
    blocked_confirmed_preview = None
    if blocked_confirmed_lines:
        blocked_filename = "blocked-confirmed-cases.md"
        write_markdown(
            output_dir / blocked_filename,
            "Blocked Confirmed Cases",
            [
                LOCAL_PREVIEW_NOTICE,
                "",
                *blocked_confirmed_lines,
            ],
        )
        blocked_confirmed_preview = {
            "title": "Blocked confirmed cases",
            "preview_relative_path": f"previews/{blocked_filename}",
            "case_count": sum(
                1 for line in blocked_confirmed_lines if line.startswith("<summary>[")
            ),
        }

    readme_lines = _build_repository_preview_index_readme(
        preview_items,
        blocked_confirmed_preview=blocked_confirmed_preview,
    )
    (output_dir / "README.md").write_text(
        "\n".join(readme_lines) + "\n",
        encoding="utf-8",
    )

    return {
        "kind": "repository-draft-pr-preview",
        "directory_relative_path": "previews",
        "directory_path": str(output_dir),
        "item_count": len(preview_items),
        "items": preview_items,
        **(
            {"blocked_confirmed_case_preview": blocked_confirmed_preview}
            if blocked_confirmed_preview
            else {}
        ),
        "readme_relative_path": "previews/README.md",
    }


__all__ = ["write_repository_draft_pr_previews"]
