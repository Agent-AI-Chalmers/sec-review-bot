from annotationlib import Format, get_annotations
from typing import Any

from sec_review_agents.review_stages import record as review_record_module
from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.workflows.issue.single_agent import (
    build_issue_single_agent_review_record,
)


def test_review_record_builder_return_annotation_is_public_payload() -> None:
    builders = (build_review_record,)

    for builder in builders:
        assert get_annotations(builder, format=Format.VALUE)["return"] == dict[str, Any]


def test_review_record_builder_returns_plain_public_payload() -> None:
    record = build_review_record(
        analysis_result=None,
        mitigation_result=None,
        verifier_result=None,
        cvss_result=None,
    )

    assert isinstance(record, dict)
    assert not hasattr(record, "model_dump")


def test_review_record_builder_treats_non_mapping_stage_results_as_not_run() -> None:
    record = build_review_record(
        analysis_result="bad",  # type: ignore[arg-type]
        mitigation_result=["bad"],  # type: ignore[arg-type]
        verifier_result=object(),  # type: ignore[arg-type]
        cvss_result="bad",  # type: ignore[arg-type]
    )

    assert record == build_review_record(
        analysis_result=None,
        mitigation_result=None,
        verifier_result=None,
        cvss_result=None,
    )


def test_review_record_contract_tracks_required_top_level_sections() -> None:
    record = review_record_module.build_review_record(
        analysis_result=None,
        mitigation_result=None,
        verifier_result=None,
        cvss_result=None,
    )
    assert set(record) == {
        "analysis",
        "mitigation",
        "verification",
        "cvss",
    }


def test_issue_review_record_projects_staged_result_with_patch(tmp_path) -> None:
    workspace_root = tmp_path / "local" / "workspace"
    workspace_root.mkdir(parents=True)
    (workspace_root / "app.py").write_text("print('fixed')\n", encoding="utf-8")
    analysis_result = {
        "overview": "confirmed traversal",
        "verdict": "confirmed-defect",
    }
    mitigation_result = {
        "status": "completed",
        "overview": "normalized paths",
        "changed_files": ["app.py"],
        "file_changes": [
            {
                "path": "app.py",
                "status": "upsert",
                "content": "print('fixed')\n",
                "content_encoding": "utf-8",
            }
        ],
        "patch_diff": "diff --git a/app.py b/app.py\n",
    }
    verifier_result = {
        "patch_coverage": "full",
        "regression_status": "not-run",
        "patch_findings": [],
        "verification_findings": ["Checked normalized path handling."],
        "validation_level": "static",
    }

    record = build_review_record(
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        verifier_result=verifier_result,
        cvss_result=None,
    )

    assert "target" not in record
    assert "strategy" not in record
    assert record["mitigation"]["patch_diff"] == "diff --git a/app.py b/app.py\n"
    assert record["mitigation"]["file_changes"] == [
        {
            "path": "app.py",
            "status": "upsert",
            "content": "print('fixed')\n",
            "content_encoding": "utf-8",
        }
    ]
    assert record["verification"]["patch_coverage"] == "full"
    assert record["verification"]["regression_status"] == "not-run"
    assert record["verification"]["patch_findings"] == []
    assert record["verification"]["verification_findings"] == [
        "Checked normalized path handling."
    ]
    assert "disposition" not in record
    assert "raw" not in record


def test_review_record_keeps_analysis_residual_risks_out_of_public_record() -> None:
    record = build_review_record(
        analysis_result={
            "status": "completed",
            "overview": "confirmed",
            "verdict": "confirmed-vulnerability",
            "narratives": [
                {
                    "priority": 1,
                    "verdict": "confirmed-vulnerability",
                    "description": "source reaches sink",
                }
            ],
        },
        mitigation_result=None,
        verifier_result=None,
        cvss_result=None,
    )

    assert record["analysis"]["narratives"] == [
        {
            "priority": 1,
            "verdict": "confirmed-vulnerability",
            "description": "source reaches sink",
        }
    ]
    assert "residual_risks" not in record["analysis"]


def test_issue_review_record_projects_deleted_and_binary_file_changes(tmp_path) -> None:
    workspace_root = tmp_path / "local" / "workspace"
    workspace_root.mkdir(parents=True)
    (workspace_root / "image.bin").write_bytes(b"\x00\x01")
    record = build_review_record(
        analysis_result={"verdict": "confirmed-defect"},
        mitigation_result={
            "status": "completed",
            "changed_files": ["image.bin", "deleted.txt"],
            "file_changes": [
                {
                    "path": "image.bin",
                    "status": "upsert",
                    "content": "AAE=",
                    "content_encoding": "base64",
                },
                {
                    "path": "deleted.txt",
                    "status": "deleted",
                },
            ],
        },
        verifier_result={"patch_coverage": "full"},
        cvss_result=None,
    )

    assert record["mitigation"]["file_changes"] == [
        {
            "path": "image.bin",
            "status": "upsert",
            "content": "AAE=",
            "content_encoding": "base64",
        },
        {
            "path": "deleted.txt",
            "status": "deleted",
        },
    ]


def test_issue_single_agent_review_record_projects_combined_result() -> None:
    single_agent_result = {
        "overview": "Applied escaping.",
        "verdict": "confirmed-defect",
        "target_claim": "Unsafe shell command composition.",
        "changed_files": ["server.py"],
        "file_changes": [
            {
                "path": "server.py",
                "status": "upsert",
                "content": "print('safe')\n",
                "content_encoding": "utf-8",
            }
        ],
        "patch_diff": "diff --git a/server.py b/server.py\n",
        "residual_risks": [],
        "self_check_notes": ["Checked command construction."],
    }

    record = build_issue_single_agent_review_record(
        single_agent_result=single_agent_result,
    )

    assert "strategy" not in record
    assert record["mitigation"]["patch_diff"] == "diff --git a/server.py b/server.py\n"
    assert record["mitigation"]["file_changes"] == [
        {
            "path": "server.py",
            "status": "upsert",
            "content": "print('safe')\n",
            "content_encoding": "utf-8",
        }
    ]
    assert "raw" not in record


def test_issue_single_agent_skipped_mitigation_projects_not_needed() -> None:
    single_agent_result = {
        "overview": "No code change needed.",
        "verdict": "no-actionable-finding",
        "target_claim": "No actionable issue.",
        "changed_files": [],
        "file_changes": [],
        "residual_risks": ["Manual review may still be useful."],
        "self_check_notes": ["No patch target."],
    }

    record = build_issue_single_agent_review_record(
        single_agent_result=single_agent_result,
    )

    assert "residual_risks" not in record["analysis"]


def test_review_record_analysis_projection_ignores_legacy_public_status_input() -> None:
    for legacy_status in ("confirmed", "success"):
        record = build_review_record(
            analysis_result={
                "status": legacy_status,
                "overview": "already projected public analysis",
                "verdict": "no-actionable-finding",
            },
            mitigation_result=None,
            verifier_result=None,
            cvss_result=None,
        )

        assert record["analysis"]["verdict"] == "no-actionable-finding"


def test_review_record_analysis_projection_drops_unrecognized_verdicts() -> None:
    for verdict in ("false-positive", "not-reproducible"):
        record = build_review_record(
            analysis_result={
                "status": "completed",
                "overview": "legacy analyzer verdict",
                "verdict": verdict,
            },
            mitigation_result=None,
            verifier_result=None,
            cvss_result=None,
        )

        assert record["analysis"]["verdict"] is None


def test_review_record_preserves_empty_changed_files() -> None:
    record = build_review_record(
        analysis_result={
            "verdict": "confirmed-defect",
        },
        mitigation_result={
            "status": "completed",
            "overview": "claimed applied without exported files",
            "changed_files": [],
        },
        verifier_result=None,
        cvss_result=None,
    )

    assert record["mitigation"]["changed_files"] == []


def test_repository_case_review_record_keeps_delivery_gate_out_of_review_record(
    tmp_path,
) -> None:
    analysis_result = {
        "overview": "confirmed SQLi",
        "verdict": "confirmed-vulnerability",
    }
    mitigation_result = {
        "status": "completed",
        "overview": "parameterized query",
        "changed_files": ["src/a.py"],
        "patch_diff": "diff --git a/src/a.py b/src/a.py\n",
    }
    verifier_result = {
        "overview": "SQL injection coverage accepted.",
        "review_target_claim": "SQL injection in src/a.py was fixed.",
        "patch_coverage": "full",
        "validation_level": "static",
    }
    cvss_result = {
        "outcome": "scored",
        "base_score": 8.1,
        "severity": "high",
        "vector": "CVSS:4.0/...",
    }

    record = build_review_record(
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        verifier_result=verifier_result,
        cvss_result=cvss_result,
    )

    assert "target" not in record
    record_cvss = record["cvss"]
    assert record_cvss is not None
    assert record_cvss["outcome"] == "scored"
    assert record_cvss["severity"] == "high"
    assert record["verification"]["review_target_claim"] == (
        "SQL injection in src/a.py was fixed."
    )
    assert "disposition" not in record
    assert record["mitigation"]["changed_files"] == ["src/a.py"]
    assert record["mitigation"]["patch_diff"] == "diff --git a/src/a.py b/src/a.py\n"
    assert "raw" not in record


def test_repository_case_review_record_preserves_not_scored_cvss_outcome():
    cvss_result = {
        "outcome": "not-scored",
        "overview": "Hardening case is not independently scoreable.",
        "base_score": None,
        "severity": None,
        "vector": None,
        "not_scored_reason": "Impact amplifier only.",
        "raw": {"reason": "debug-only reason must not drive public review record"},
    }

    record = build_review_record(
        analysis_result={"verdict": "confirmed-defect"},
        mitigation_result=None,
        verifier_result=None,
        cvss_result=cvss_result,
    )

    assert record["cvss"]["outcome"] == "not-scored"
    assert record["cvss"]["base_score"] is None
    assert record["cvss"]["severity"] is None
    assert record["cvss"]["not_scored_reason"] == "Impact amplifier only."


def test_repository_case_review_record_normalizes_integer_cvss_base_score() -> None:
    record = build_review_record(
        analysis_result={"verdict": "confirmed-defect"},
        mitigation_result=None,
        verifier_result=None,
        cvss_result={
            "outcome": "scored",
            "base_score": 10,
            "severity": "critical",
            "vector": "CVSS:4.0/...",
        },
    )

    cvss = record["cvss"]
    assert cvss is not None
    assert cvss["base_score"] == 10.0


def test_repository_case_review_record_does_not_read_cvss_reason_from_raw():
    record = build_review_record(
        analysis_result={"verdict": "confirmed-defect"},
        mitigation_result=None,
        verifier_result=None,
        cvss_result={
            "outcome": "not-scored",
            "overview": "Hardening case is not independently scoreable.",
            "base_score": None,
            "severity": None,
            "vector": None,
            "raw": {"reason": "debug-only"},
        },
    )

    assert record["cvss"]["outcome"] == "not-scored"
    assert record["cvss"]["not_scored_reason"] is None
