from pathlib import Path

from sec_review_agents.cli.local_previewing.issue import write_issue_previews
from sec_review_agents.cli.local_previewing.pull_request import (
    write_pull_request_previews,
)


def _materialized_input(local_root: Path) -> dict:
    return {
        "issue": {"number": 7, "title": "Dangerous preview endpoint"},
        "pr": {"number": 11},
        "input_bundle_root_path": str(local_root),
    }


def _workflow_result() -> dict:
    return {
        "review_record": {
            "analysis": {
                "verdict": "confirmed-vulnerability",
                "overview": (
                    "The endpoint in `agents/src/example.py` exposed sensitive files."
                ),
                "narratives": [
                    {
                        "priority": 2,
                        "title": "Unsafe preview endpoint",
                        "verdict": "confirmed-vulnerability",
                        "vulnerability_type": "Path traversal",
                        "validation_level": "static",
                        "description": "User input reaches `open_file()`.",
                        "locations": [
                            {
                                "file": "src/server.js",
                                "line": 12,
                                "label": "file read",
                            }
                        ],
                        "flow_review": {
                            "source_facts": ["Preview path comes from request input."],
                            "sink_facts": ["The endpoint reads from disk."],
                        },
                        "control_review": {
                            "reachable_assets": ["Files below the preview root."],
                            "security_controls": ["Root containment check."],
                            "control_limits": ["Runtime exploit was not exercised."],
                        },
                        "support_review": {
                            "proof_gaps": ["Runtime exploit was not exercised."],
                        },
                    }
                ],
                "residual_risks": [],
            },
            "mitigation": {
                "overview": "Restricted the endpoint to a safe root.",
                "changed_files": ["src/server.js"],
                "patch_diff": "--- a/src/server.js\n+++ b/src/server.js\n@@\n-old\n+new\n",
                "residual_risks": [],
            },
            "verification": {
                "review_target_claim": ("`MemoryObservationOutput` remains unchanged."),
                "patch_coverage": "full",
                "resolution_next_step": "none",
                "patch_findings": [],
                "verification_findings": [],
                "residual_risks": [],
            },
        }
    }


def test_writes_issue_comment_and_draft_pr_previews(tmp_path: Path) -> None:
    local_root = tmp_path / "run-1"
    run_artifacts = local_root / "artifacts"
    result = write_issue_previews(
        local_root_path=local_root,
        materialized_input=_materialized_input(local_root),
        workflow_result=_workflow_result(),
    )

    assert result["directory_relative_path"] == "previews"
    assert result["item_count"] == 2
    comment = run_artifacts / "previews" / "issue-comment.md"
    draft_pr = run_artifacts / "previews" / "draft-pr.md"
    assert comment.is_file()
    assert draft_pr.is_file()
    readme_content = (run_artifacts / "previews" / "README.md").read_text(
        encoding="utf-8"
    )
    assert "Local-only preview files" in readme_content
    assert "not part of the runner or app contract" in readme_content
    assert "## Security Review" in comment.read_text(encoding="utf-8")
    draft_content = draft_pr.read_text(encoding="utf-8")
    assert "Narratives:" in draft_content
    assert "**Unsafe preview endpoint**" in draft_content
    assert "- Vulnerability type: `Path traversal`" in draft_content
    assert "Control review:" in draft_content
    assert "Reachable assets:" in draft_content
    assert "- Files below the preview root." in draft_content
    assert "Security controls:" in draft_content
    assert "- Root containment check." in draft_content
    assert "Control limits:" in draft_content
    assert "- Priority:" not in draft_content
    assert "## Final Patch Preview" in draft_content
    assert "-old" in draft_content
    assert "+new" in draft_content


def test_writes_pull_request_review_body_preview(tmp_path: Path) -> None:
    local_root = tmp_path / "run-1"
    run_artifacts = local_root / "artifacts"
    result = write_pull_request_previews(
        local_root_path=local_root,
        materialized_input=_materialized_input(local_root),
        workflow_result=_workflow_result(),
    )

    assert result["directory_relative_path"] == "previews"
    review_body = run_artifacts / "previews" / "review-body.md"
    assert review_body.is_file()
    review_content = review_body.read_text(encoding="utf-8")
    assert "<summary>Analysis</summary>" in review_content
    assert "<summary>Analysis narratives</summary>" not in review_content
    assert "**Unsafe preview endpoint**" in review_content
    assert "`agents/src/example.py`" in review_content
    assert "`open_file()`" in review_content
    assert "`MemoryObservationOutput` remains unchanged." in review_content
    assert "Control review:" in review_content
    assert "- Files below the preview root." in review_content
    assert "- Priority:" not in review_content
    readme_content = (run_artifacts / "previews" / "README.md").read_text(
        encoding="utf-8"
    )
    assert "Local-only preview files" in readme_content
    assert "not part of the runner or app contract" in readme_content
    content = review_body.read_text(encoding="utf-8")
    assert "## PR Security Review" in content
    assert "## Final Patch Preview" in content


def test_pull_request_preview_summarizes_review_stages(tmp_path: Path) -> None:
    local_root = tmp_path / "run-1"
    workflow_result = _workflow_result()
    review_record = workflow_result["review_record"]
    review_record["analysis"]["verdict"] = "no-actionable-finding"
    review_record["mitigation"]["changed_files"] = []
    review_record["mitigation"]["patch_diff"] = None
    review_record["verification"].update(
        {
            "validation_level": "static",
            "patch_coverage": "not-applicable",
            "regression_status": "not-run",
            "resolution_next_step": "none",
        }
    )

    write_pull_request_previews(
        local_root_path=local_root,
        materialized_input=_materialized_input(local_root),
        workflow_result=workflow_result,
    )

    content = (local_root / "artifacts" / "previews" / "review-body.md").read_text(
        encoding="utf-8"
    )
    assert "- Analysis: `no actionable security finding`" in content
    assert "- Mitigation: `not needed`" in content
    assert "- Verification: `static review; checks not run`" in content
    assert "- Tests:" not in content
    assert "Changed files: `0`" not in content
    assert "Resolution next step: `none`" not in content


def test_pull_request_preview_reports_patch_and_manual_review(tmp_path: Path) -> None:
    local_root = tmp_path / "run-1"
    workflow_result = _workflow_result()
    review_record = workflow_result["review_record"]
    review_record["analysis"]["verdict"] = "confirmed-vulnerability"
    review_record["mitigation"]["changed_files"] = ["src/a.py", "src/b.py"]
    review_record["verification"].update(
        {
            "validation_level": "runtime-partial",
            "regression_status": "failed",
            "resolution_next_step": "manual-review",
        }
    )

    write_pull_request_previews(
        local_root_path=local_root,
        materialized_input=_materialized_input(local_root),
        workflow_result=workflow_result,
    )

    content = (local_root / "artifacts" / "previews" / "review-body.md").read_text(
        encoding="utf-8"
    )
    assert "- Analysis: `confirmed security vulnerability`" in content
    assert "- Mitigation: `patch proposed, 2 files changed`" in content
    assert "- Verification: `partial runtime validation; checks failed`" in content
    assert "- Tests:" not in content
    assert "- Resolution next step: `manual-review`" in content
