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


def _analysis_headline(verdict: Any) -> str:
    return {
        "no-actionable-finding": "no actionable security finding",
        "confirmed-vulnerability": "confirmed security vulnerability",
        "confirmed-defect": "confirmed security defect",
        "plausible-risk": "plausible security risk",
        "inconclusive": "inconclusive",
    }.get(verdict, "unknown")


def _mitigation_headline(verdict: Any, changed_files: list[Any]) -> str:
    if changed_files:
        noun = "file" if len(changed_files) == 1 else "files"
        return f"patch proposed, {len(changed_files)} {noun} changed"
    return "not needed" if verdict == "no-actionable-finding" else "no patch proposed"


def _verification_headline(validation_level: Any) -> str:
    return {
        "static": "static review",
        "logic-simulated": "logic simulation",
        "runtime-partial": "partial runtime validation",
        "runtime-endpoint": "runtime endpoint validation",
    }.get(validation_level, "not recorded")


def _checks_headline(regression_status: Any) -> str:
    return {
        "passed": "checks passed",
        "failed": "checks failed",
        "not-run": "checks not run",
        "not-applicable": "checks not applicable",
        "unresolved": "checks unresolved",
    }.get(regression_status, "checks not recorded")


def _render_pr_review_body(review_record: dict[str, Any]) -> list[str]:
    analysis, mitigation, verification = _fix_sections(review_record)
    changed_files = as_list(mitigation.get("changed_files"))
    lines = [
        "## PR Security Review",
        "",
        f"- Analysis: {inline_code(_analysis_headline(analysis.get('verdict')))}",
        f"- Mitigation: {inline_code(_mitigation_headline(analysis.get('verdict'), changed_files))}",
        "- Verification: "
        + inline_code(
            f"{_verification_headline(verification.get('validation_level'))}; "
            f"{_checks_headline(verification.get('regression_status'))}"
        ),
        *(
            [
                f"- Resolution next step: {inline_code(verification.get('resolution_next_step'), 'unknown')}"
            ]
            if verification.get("resolution_next_step") != "none"
            else []
        ),
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
        verification_details = {
            **verification,
            "resolution_next_step": (
                None
                if verification.get("resolution_next_step") == "none"
                else verification.get("resolution_next_step")
            ),
        }
        lines.extend(
            folded_block(
                "Verification",
                render_verification_preview_lines(verification_details),
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
