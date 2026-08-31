from pathlib import Path
from typing import Any

from sec_review_agents.cli.local_previewing.shared import (
    as_dict,
    as_list,
    patch_block,
    render_analysis_narratives,
    render_mitigation_preview_lines,
    render_verification_preview_lines,
)
from sec_review_agents.utils.markdown import (
    compact_plain_text,
    dedupe_text_items,
    folded_block,
    inline_code,
    md,
    plain_text,
    write_markdown,
)
from sec_review_agents.utils.paths import required_path


def _fix_sections(
    review_record: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    analysis = as_dict(review_record.get("analysis"))
    mitigation = as_dict(review_record.get("mitigation"))
    verification = as_dict(review_record.get("verification"))
    return analysis, mitigation, verification


def _render_issue_comment(
    *,
    issue_number: Any,
    review_record: dict[str, Any],
    draft_pr_ready: bool,
) -> list[str]:
    analysis, mitigation, verification = _fix_sections(review_record)
    headline = (
        f"Verifier assessed patch={inline_code(verification.get('patch_coverage'), 'unknown')}."
        if verification.get("patch_coverage")
        else compact_plain_text(
            analysis.get("overview"),
            f"Security review completed for issue #{issue_number}.",
        )
    )
    lines = [
        "## Security Review",
        "",
        f"**Risk Verdict:** {inline_code(analysis.get('verdict'), 'unknown')}",
        f"**Patch Coverage:** {inline_code(verification.get('patch_coverage'), 'unknown')}",
        f"**Patch Ready:** {inline_code('yes' if draft_pr_ready else 'no')}",
        f"**Next Step:** {inline_code('open-draft-pr' if draft_pr_ready else 'issue-only')}",
        "",
        headline,
        "",
    ]
    if not draft_pr_ready:
        lines.extend(
            folded_block(
                "Analysis",
                [
                    f"**Verdict:** {inline_code(analysis.get('verdict'), 'unknown')}",
                    "",
                    plain_text(analysis.get("overview"), "Issue analysis completed."),
                    "",
                    *render_analysis_narratives(analysis.get("narratives")),
                ],
            )
        )
        lines.append("")
        lines.extend(
            folded_block(
                "Mitigation",
                render_mitigation_preview_lines(
                    mitigation,
                    fallback="Issue mitigation completed.",
                ),
            )
        )
        lines.append("")
    return lines


def _render_issue_draft_pr(
    *,
    issue_number: Any,
    review_record: dict[str, Any],
) -> list[str]:
    analysis, mitigation, verification = _fix_sections(review_record)
    changed_files = dedupe_text_items(as_list(mitigation.get("changed_files")))
    residual_risks = dedupe_text_items(
        as_list(verification.get("residual_risks")),
        limit=6,
    )
    return [
        f"Refs #{issue_number}",
        "",
        f"<!-- sec-review-bot:generated-from-issue-{issue_number} -->",
        f"<!-- sec-review-bot-patch-coverage: {verification.get('patch_coverage') or 'unknown'} -->",
        f"<!-- sec-review-bot-resolution-next-step: {verification.get('resolution_next_step') or 'unknown'} -->",
        f"<!-- sec-review-bot-validation-level: {verification.get('validation_level') or 'unknown'} -->",
        f"<!-- sec-review-bot-changed-file-count: {len(changed_files)} -->",
        f"<!-- sec-review-bot-residual-risk-count: {len(residual_risks)} -->",
        "",
        "## Summary",
        "",
        f"This draft PR applies a focused mitigation for security issue #{issue_number}.",
        "",
        f"**Patch Coverage:** {inline_code(verification.get('patch_coverage'), 'unknown')}",
        f"**Resolution Next Step:** {inline_code(verification.get('resolution_next_step'), 'unknown')}",
        f"**Changed Files:** {inline_code(len(changed_files))}",
        "",
        plain_text(
            mitigation.get("overview")
            or analysis.get("overview")
            or f"This change mitigates the security issue reported in #{issue_number}."
        ),
        "",
        *folded_block(
            "Analysis",
            [
                f"- Verdict: {inline_code(analysis.get('verdict'), 'unknown')}",
                "",
                plain_text(analysis.get("overview"), "Issue analysis completed."),
                "",
                *render_analysis_narratives(analysis.get("narratives")),
            ],
        ),
        "",
        *folded_block(
            "Code Changes",
            [
                "Changed files:",
                "",
                *(
                    [f"- {inline_code(path)}" for path in changed_files]
                    if changed_files
                    else ["- No changed files were recorded."]
                ),
                "",
                "Exact code changes are available in the PR Files changed view.",
            ],
        ),
        "",
        *folded_block(
            "Verification",
            render_verification_preview_lines(verification),
        ),
        "",
        *patch_block(mitigation.get("patch_diff")),
    ]


def _preview_index_lines(items: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for item in items:
        kind = inline_code(item["kind"])
        preview_name = Path(str(item["preview_relative_path"])).name
        rendered_preview_name = md(t"{preview_name}")
        lines.append(f"- {kind}: [{rendered_preview_name}](./{preview_name})")
    return lines


def write_issue_previews(
    *,
    materialized_input: dict[str, Any],
    workflow_result: dict[str, Any],
) -> dict[str, Any]:
    issue = as_dict(materialized_input.get("issue"))
    issue_number = issue.get("number") or "unknown"
    issue_title = compact_plain_text(
        issue.get("title"), f"Mitigate security issue #{issue_number}"
    )
    review_record = as_dict(workflow_result.get("review_record"))
    mitigation = as_dict(review_record.get("mitigation"))
    draft_pr_ready = bool(as_list(mitigation.get("changed_files")))
    output_dir = (
        required_path(
            materialized_input.get("input_bundle_uri"),
            label="input_bundle_uri",
        )
        / "artifacts"
        / "previews"
    )
    items: list[dict[str, Any]] = []

    comment_path = output_dir / "issue-comment.md"
    write_markdown(
        comment_path,
        "Issue Comment Preview",
        _render_issue_comment(
            issue_number=issue_number,
            review_record=review_record,
            draft_pr_ready=draft_pr_ready,
        ),
    )
    items.append(
        {
            "kind": "issue-comment",
            "preview_relative_path": "previews/issue-comment.md",
        }
    )

    if draft_pr_ready:
        draft_path = output_dir / "draft-pr.md"
        write_markdown(
            draft_path,
            f"[sec] {issue_title}",
            _render_issue_draft_pr(
                issue_number=issue_number,
                review_record=review_record,
            ),
        )
        items.append(
            {
                "kind": "issue-draft-pr",
                "preview_relative_path": "previews/draft-pr.md",
            }
        )

    readme = output_dir / "README.md"
    readme_lines = [
        "# Issue Previews",
        "",
        "Local-only preview files for inspecting the publishable issue workflow output.",
        "These files are generated for local inspection and are not part of the runner or app contract.",
        "",
        *_preview_index_lines(items),
    ]
    readme.write_text("\n".join(readme_lines) + "\n", encoding="utf-8")
    return {
        "kind": "issue-preview",
        "directory_relative_path": "previews",
        "directory_path": str(output_dir),
        "item_count": len(items),
        "items": items,
        "readme_relative_path": "previews/README.md",
    }


__all__ = ["write_issue_previews"]
