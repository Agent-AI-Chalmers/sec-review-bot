from pathlib import Path

from sec_review_agents.cli.local_previewing.repository import (
    write_repository_draft_pr_previews,
)


def test_writes_publishable_preview_outside_patch_synthesis(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    run_artifacts = local_root / "artifacts"
    workspace = local_root / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "src").mkdir()
    (workspace / "src" / "server.js").write_text(
        "const root = process.cwd()\n",
        encoding="utf-8",
    )
    artifact = {
        "delivery_id": "case-1",
        "strategy": "single",
        "case_count": 1,
        "case_ids": ["case-1"],
        "file_changes": [
            {
                "path": "src/server.js",
                "content": "const root = PREVIEW_ROOT\n",
                "content_encoding": "utf-8",
            }
        ],
    }
    case_result = {
        "case_id": "case-1",
        "disposition": "keep",
        "review_record": {
            "analysis": {
                "verdict": "confirmed-vulnerability",
                "overview": "Preview endpoint exposed repository files.",
                "narratives": [
                    {
                        "priority": 3,
                        "title": "Unsafe preview root",
                        "verdict": "confirmed-vulnerability",
                        "vulnerability_type": "Path traversal",
                        "validation_level": "static",
                        "description": "Preview root can expose files.",
                        "locations": [
                            {
                                "file": "src/server.js",
                                "line": 1,
                                "label": "root selection",
                            }
                        ],
                        "flow_review": {
                            "source_facts": ["Request controls the preview path."],
                            "sink_facts": ["Server reads from the selected root."],
                        },
                        "control_review": {
                            "reachable_assets": [
                                "Repository files under the preview root."
                            ],
                            "security_controls": ["Preview root selection."],
                            "control_limits": ["No endpoint runtime test was run."],
                        },
                        "support_review": {
                            "proof_gaps": ["No endpoint runtime test was run."],
                        },
                    }
                ],
            },
            "mitigation": {
                "overview": "Restrict preview root.",
                "changed_files": ["src/server.js"],
            },
            "verification": {
                "patch_coverage": "full",
                "resolution_next_step": "none",
                "validation_level": "static",
                "patch_findings": ["Reviewer-visible concern."],
                "verification_findings": [],
                "residual_risks": [],
            },
            "cvss": {
                "outcome": "scored",
                "vector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N",
                "base_score": 8.7,
                "severity": "high",
                "overview": "High confidentiality impact.",
            },
        },
    }
    materialized_input = {
        "input_bundle_uri": str(local_root),
    }
    result = write_repository_draft_pr_previews(
        materialized_input=materialized_input,
        deliveries=[artifact],
        case_results=[case_result],
    )

    assert result["directory_relative_path"] == "previews"
    assert "patch-synthesis" not in result["directory_relative_path"]
    preview_path = run_artifacts / "previews" / "case-1.md"
    assert preview_path.is_file()
    content = preview_path.read_text(encoding="utf-8")
    assert "# [sec] Repository delivery case-1 in src/server.js" in content
    assert "Local developer preview only" in content
    assert "This PR applies security mitigations" in content
    assert "## Modified Files" in content
    assert "- `src/server.js`" in content
    assert "## Case Details" in content
    assert (
        "_The following sections summarize case-level stage outputs. "
        "For combined deliveries, the final PR diff is authoritative._"
    ) in content
    assert "- Status: `patched`" not in content
    assert "Restrict preview root." in content
    assert "#### Case Summary" not in content
    assert "<summary>Analysis</summary>" in content
    assert "Narratives:" in content
    assert "**Unsafe preview root**" in content
    assert "- Vulnerability type: `Path traversal`" in content
    assert "Control review:" in content
    assert "- Repository files under the preview root." in content
    assert "- Preview root selection." in content
    assert "- No endpoint runtime test was run." in content
    assert "- Priority:" not in content
    assert "- Validation level: `static`" in content
    assert "Affected paths:" not in content
    assert "##### Evidence anchors" not in content
    assert "- Patch coverage: `full`" in content
    assert "- Resolution next step: `none`" in content
    assert "- Case disposition: `keep`" not in content
    assert "- Analyzer verdict: `confirmed-vulnerability`" in content
    assert "<summary>CVSS</summary>" in content
    assert "<summary>Mitigation</summary>" in content
    assert "#### Mitigation notes" not in content
    assert "\n#### Evidence\n" not in content
    assert "#### Analyzer Result" not in content
    assert "#### CVSS Scoring" not in content
    assert "<summary>Audit metadata</summary>" not in content
    assert "## Final Patch Preview" in content
    assert "-const root = process.cwd()" in content
    assert "+const root = PREVIEW_ROOT" in content
    assert "Reviewer-visible concern." in content
    assert "##### Residual risks" not in content
    assert (preview_path.parent / "README.md").is_file()


def test_preview_notes_shared_modified_files_across_deliveries(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    run_artifacts = local_root / "artifacts"
    workspace = local_root / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "src").mkdir()
    (workspace / "src" / "server.js").write_text(
        "initial\n",
        encoding="utf-8",
    )
    write_repository_draft_pr_previews(
        materialized_input={
            "input_bundle_uri": str(local_root),
        },
        deliveries=[
            {
                "delivery_id": "case-1",
                "strategy": "single",
                "case_count": 1,
                "file_changes": [
                    {
                        "path": "src/server.js",
                        "content": "first\n",
                        "content_encoding": "utf-8",
                    }
                ],
                "case_ids": ["case-1"],
            },
            {
                "delivery_id": "case-2",
                "strategy": "single",
                "case_count": 1,
                "file_changes": [
                    {
                        "path": "src/server.js",
                        "content": "second\n",
                        "content_encoding": "utf-8",
                    }
                ],
                "case_ids": ["case-2"],
            },
        ],
    )

    pr_content = (run_artifacts / "previews" / "case-1.md").read_text(encoding="utf-8")
    readme_content = (run_artifacts / "previews" / "README.md").read_text(
        encoding="utf-8"
    )
    assert "## Coordination Notes" not in pr_content
    assert "# Repository Delivery Previews" in readme_content
    assert "Local-only preview files" in readme_content
    assert "not part of the runner or app contract" in readme_content
    assert "## Coordination Notes" in readme_content
    assert "Shared modified file `src/server.js`" in readme_content
    assert "[`case-1`](./case-1.md)" in readme_content
    assert "[`case-2`](./case-2.md)" in readme_content
    assert (
        "These previews touch the same file; review publish order if publishing them together."
        in readme_content
    )


def test_final_patch_preview_handles_deleted_and_binary_file_changes(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    run_artifacts = local_root / "artifacts"
    workspace = local_root / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "src").mkdir()
    (workspace / "src" / "remove.txt").write_text(
        "delete me\n",
        encoding="utf-8",
    )

    write_repository_draft_pr_previews(
        materialized_input={
            "input_bundle_uri": str(local_root),
        },
        deliveries=[
            {
                "delivery_id": "case-1",
                "strategy": "single",
                "case_count": 1,
                "file_changes": [
                    {
                        "path": "src/remove.txt",
                        "status": "deleted",
                    },
                    {
                        "path": "src/logo.bin",
                        "status": "upsert",
                        "content": "AAE=",
                        "content_encoding": "base64",
                    },
                ],
                "case_ids": ["case-1"],
            }
        ],
    )

    content = (run_artifacts / "previews" / "case-1.md").read_text(encoding="utf-8")
    assert "## Final Patch Preview" in content
    assert "-delete me" in content
    assert "Skipped non-text file changes:" in content
    assert "- `src/logo.bin`" in content
    assert "AAE=" not in content


def test_writes_blocked_confirmed_cases_preview(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    run_artifacts = local_root / "artifacts"
    result = write_repository_draft_pr_previews(
        materialized_input={
            "input_bundle_uri": str(local_root),
        },
        deliveries=[],
        case_results=[
            {
                "case_id": "case-1",
                "disposition": "blocked",
                "reason": "The verifier did not fully approve the patch.",
                "review_record": {
                    "analysis": {
                        "verdict": "confirmed-defect",
                        "overview": "Webhook retry payloads can reuse stale signature metadata.",
                    },
                    "cvss": {
                        "outcome": "scored",
                        "base_score": 5.8,
                        "severity": "medium",
                        "vector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N",
                        "overview": "Replay can affect queued webhook processing.",
                    },
                    "mitigation": {
                        "overview": "The attempted patch covers direct webhook requests only.",
                        "patch_diff": "diff --git a/src/webhook.ts b/src/webhook.ts\n+verifyRetrySignature()\n",
                    },
                    "verification": {
                        "patch_coverage": "partial",
                        "resolution_next_step": "Manual review needed.",
                        "overview": "Queued retry payloads remain unverified.",
                    },
                },
            }
        ],
    )

    preview = result["blocked_confirmed_case_preview"]
    assert preview["case_count"] == 1
    preview_path = run_artifacts / "previews" / "blocked-confirmed-cases.md"
    assert preview_path.is_file()
    content = preview_path.read_text(encoding="utf-8")
    assert "# Blocked Confirmed Cases" in content
    assert "Local developer preview only" in content
    assert "<summary>[medium] case-1" in content
    assert "<summary>Analysis</summary>" in content
    assert "<summary>CVSS</summary>" in content
    assert "<summary>Mitigation</summary>" in content
    assert "<summary>Reference patch</summary>" in content
    assert "+verifyRetrySignature()" in content
    assert "<summary>Verification</summary>" in content
    assert content.index("<summary>Analysis</summary>") < content.index(
        "<summary>CVSS</summary>"
    )
    assert content.index("<summary>CVSS</summary>") < content.index(
        "<summary>Mitigation</summary>"
    )
    assert content.index("<summary>Mitigation</summary>") < content.index(
        "<summary>Verification</summary>"
    )
    readme_content = (run_artifacts / "previews" / "README.md").read_text(
        encoding="utf-8"
    )
    assert "## Blocked Confirmed Cases" in readme_content
    assert "[Blocked confirmed cases](./blocked-confirmed-cases.md)" in readme_content
