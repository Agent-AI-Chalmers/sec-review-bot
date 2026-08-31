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
    folded_block,
    inline_code,
    plain_text,
    write_markdown,
)
from sec_review_agents.utils.paths import required_path


def _review_record(workflow_result: dict[str, Any]) -> dict[str, Any]:
    review_record = workflow_result.get("review_record")
    return review_record if isinstance(review_record, dict) else {}


def _fix_sections(
    review_record: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    analysis = as_dict(review_record.get("analysis"))
    mitigation = as_dict(review_record.get("mitigation"))
    verification = as_dict(review_record.get("verification"))
    return analysis, mitigation, verification


def _analysis_lines(analysis: dict[str, Any]) -> list[str]:
    return [
        f"- Verdict: {inline_code(analysis.get('verdict'), 'unknown')}",
        "",
        plain_text(analysis.get("overview"), "No overview provided."),
        "",
        *render_analysis_narratives(analysis.get("narratives")),
    ]


def _render_pr_review_body(review_record: dict[str, Any]) -> list[str]:
    analysis, mitigation, verification = _fix_sections(review_record)
    changed_files = as_list(mitigation.get("changed_files"))
    lines = [
        "## PR Security Review",
        "",
        f"- Verdict: {inline_code(analysis.get('verdict'), 'unknown')}",
        f"- Changed files: {inline_code(len(changed_files))}",
        f"- Verification: {inline_code(verification.get('patch_coverage'), 'unknown')}",
        f"- Regression: {inline_code(verification.get('regression_status'), 'unknown')}",
        f"- Resolution next step: {inline_code(verification.get('resolution_next_step'), 'unknown')}",
        "",
        plain_text(analysis.get("overview"), "No overview provided."),
        "",
    ]
    lines.extend(folded_block("Analysis", _analysis_lines(analysis)))
    lines.append("")
    if mitigation.get("overview") or changed_files:
        lines.extend(
            folded_block(
                "Mitigation",
                render_mitigation_preview_lines(
                    mitigation,
                    fallback="No mitigation overview was recorded.",
                ),
            )
        )
        lines.append("")
    if verification.get("patch_coverage"):
        lines.extend(
            folded_block(
                "Verification",
                render_verification_preview_lines(verification),
            )
        )
        lines.append("")
    lines.extend(patch_block(mitigation.get("patch_diff")))
    return lines


def write_pull_request_previews(
    *,
    materialized_input: dict[str, Any],
    workflow_result: dict[str, Any],
) -> dict[str, Any]:
    pr = as_dict(materialized_input.get("pr"))
    pr_number = pr.get("number") or "unknown"
    review_record = _review_record(workflow_result)
    output_dir = (
        required_path(
            materialized_input.get("input_bundle_uri"),
            label="input_bundle_uri",
        )
        / "artifacts"
        / "previews"
    )
    review_body_path = output_dir / "review-body.md"
    write_markdown(
        review_body_path,
        f"Pull Request #{pr_number} Review Body Preview",
        _render_pr_review_body(review_record),
    )
    readme = output_dir / "README.md"
    readme.write_text(
        "# Pull Request Preview\n\n"
        "Local-only preview files for inspecting the publishable pull request workflow output.\n"
        "These files are generated for local inspection and are not part of the runner or app contract.\n\n"
        "- `review-body`: [review-body.md](./review-body.md)\n",
        encoding="utf-8",
    )
    return {
        "kind": "pull-request-preview",
        "directory_relative_path": "previews",
        "directory_path": str(output_dir),
        "item_count": 1,
        "items": [
            {
                "kind": "review-body",
                "preview_relative_path": "previews/review-body.md",
            }
        ],
        "readme_relative_path": "previews/README.md",
    }


__all__ = ["write_pull_request_previews"]
