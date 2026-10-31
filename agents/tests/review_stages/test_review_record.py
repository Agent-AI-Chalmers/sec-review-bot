import pytest
from pydantic import ValidationError
from temporalio.contrib.pydantic import pydantic_data_converter

from sec_review_agents.review_stages.cvss.result import build_cvss_v4_stage_result
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.record import ReviewRecord, build_review_record
from sec_review_agents.review_stages.single_agent.result import SingleAgentFixOutcome
from sec_review_agents.review_stages.verification.result import (
    build_skipped_verification_result,
)
from sec_review_agents.workflows.issue.single_agent import (
    build_issue_single_agent_review_record,
)
from tests.analysis_fixtures import analysis_fixture
from tests.contract_fixtures import contract_validator


def test_review_record_builder_retains_model() -> None:
    record = build_review_record(
        analysis_result=None,
        mitigation_result=None,
        verifier_result=None,
        cvss_result=None,
    )
    assert isinstance(record, ReviewRecord)
    assert record.analysis.verdict is None
    assert record.cvss is None


def test_review_record_contract_tracks_required_top_level_sections() -> None:
    record = ReviewRecord.model_validate({"cvss": None}).model_dump(
        mode="json", by_alias=True
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

    record = ReviewRecord.model_validate(
        {
            "analysis": analysis_result,
            "mitigation": mitigation_result,
            "verification": verifier_result,
            "cvss": None,
        }
    ).model_dump(mode="json", by_alias=True)

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
    analysis = analysis_fixture().model_dump(mode="json", by_alias=True)
    record = ReviewRecord.model_validate(
        {"analysis": {**analysis, "residual_risks": ["Legacy risk"]}}
    ).model_dump(mode="json", by_alias=True)
    assert record["analysis"]["narratives"] == analysis["narratives"]
    assert "residual_risks" not in record["analysis"]


def test_issue_review_record_projects_deleted_and_binary_file_changes(tmp_path) -> None:
    workspace_root = tmp_path / "local" / "workspace"
    workspace_root.mkdir(parents=True)
    (workspace_root / "image.bin").write_bytes(b"\x00\x01")
    record = ReviewRecord.model_validate(
        {
            "analysis": {"verdict": "confirmed-defect"},
            "mitigation": {
                "status": "completed",
                "changed_files": ["image.bin", "deleted.txt"],
                "file_changes": [
                    {
                        "path": "image.bin",
                        "status": "upsert",
                        "content": "AAE=",
                        "content_encoding": "base64",
                    },
                    {"path": "deleted.txt", "status": "deleted"},
                ],
            },
            "verification": {"patch_coverage": "full"},
            "cvss": None,
        }
    ).model_dump(mode="json", by_alias=True)

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
        single_agent_result=SingleAgentFixOutcome.model_validate(
            {
                "validation_level": "static",
                "regression_status": "not-run",
                **single_agent_result,
            }
        ),
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
        single_agent_result=SingleAgentFixOutcome.model_validate(
            {
                "validation_level": "static",
                "regression_status": "not-run",
                **single_agent_result,
            }
        ),
    )

    assert "residual_risks" not in record["analysis"]


def test_review_record_analysis_projection_ignores_legacy_public_status_input() -> None:
    for legacy_status in ("confirmed", "success"):
        record = ReviewRecord.model_validate(
            {
                "analysis": {
                    "status": legacy_status,
                    "overview": "already projected public analysis",
                    "verdict": "no-actionable-finding",
                },
                "cvss": None,
            }
        ).model_dump(mode="json", by_alias=True)

        assert record["analysis"]["verdict"] == "no-actionable-finding"


@pytest.mark.parametrize("verdict", ["false-positive", "not-reproducible"])
def test_review_record_analysis_projection_rejects_unrecognized_verdicts(
    verdict,
) -> None:
    with pytest.raises(ValidationError) as error:
        ReviewRecord.model_validate({"analysis": {"verdict": verdict}})
    assert error.value.errors()[0]["loc"] == ("analysis", "verdict")


def test_review_record_drops_removed_changed_files_projection() -> None:
    record = ReviewRecord.model_validate(
        {
            "analysis": {"verdict": "confirmed-defect"},
            "mitigation": {
                "status": "completed",
                "overview": "claimed applied without exported files",
                "changed_files": [],
            },
            "cvss": None,
        }
    ).model_dump(mode="json", by_alias=True)

    assert "changed_files" not in record["mitigation"]
    assert record["mitigation"]["file_changes"] == []


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
        "file_changes": [{"path": "src/a.py", "status": "deleted"}],
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

    record = ReviewRecord.model_validate(
        {
            "analysis": analysis_result,
            "mitigation": mitigation_result,
            "verification": verifier_result,
            "cvss": cvss_result,
        }
    ).model_dump(mode="json", by_alias=True)

    assert "target" not in record
    record_cvss = record["cvss"]
    assert record_cvss is not None
    assert record_cvss["outcome"] == "scored"
    assert record_cvss["severity"] == "high"
    assert record["verification"]["review_target_claim"] == (
        "SQL injection in src/a.py was fixed."
    )
    assert "disposition" not in record
    assert record["mitigation"]["file_changes"] == [
        {"path": "src/a.py", "status": "deleted"}
    ]
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

    record = ReviewRecord.model_validate(
        {"analysis": {"verdict": "confirmed-defect"}, "cvss": cvss_result}
    ).model_dump(mode="json", by_alias=True)

    assert record["cvss"]["outcome"] == "not-scored"
    assert record["cvss"]["base_score"] is None
    assert record["cvss"]["severity"] is None
    assert record["cvss"]["not_scored_reason"] == "Impact amplifier only."


def test_repository_case_review_record_normalizes_integer_cvss_base_score() -> None:
    record = ReviewRecord.model_validate(
        {
            "analysis": {"verdict": "confirmed-defect"},
            "cvss": {
                "outcome": "scored",
                "base_score": 10,
                "severity": "critical",
                "vector": "CVSS:4.0/...",
            },
        }
    ).model_dump(mode="json", by_alias=True)

    cvss = record["cvss"]
    assert cvss is not None
    assert cvss["base_score"] == 10.0


def test_repository_case_review_record_does_not_read_cvss_reason_from_raw():
    record = ReviewRecord.model_validate(
        {
            "analysis": {"verdict": "confirmed-defect"},
            "cvss": {
                "outcome": "not-scored",
                "overview": "Hardening case is not independently scoreable.",
                "base_score": None,
                "severity": None,
                "vector": None,
                "raw": {"reason": "debug-only"},
            },
        }
    ).model_dump(mode="json", by_alias=True)

    assert record["cvss"]["outcome"] == "not-scored"
    assert record["cvss"]["not_scored_reason"] is None


@pytest.mark.asyncio
async def test_stage_models_project_to_record_without_losing_nested_narratives() -> (
    None
):
    """Keep validated narratives through projection and Temporal serialization."""
    analysis = analysis_fixture()
    mitigation = MitigationStageResult(
        overview="Removed entrypoint",
        file_changes=[{"path": "app.py", "status": "deleted"}],
        patch_diff="reference patch",
    )
    verification = build_skipped_verification_result(reason="Not requested")
    cvss = build_cvss_v4_stage_result(
        outcome="not-scored",
        overview="Needs impact evidence",
        not_scored_reason="Unknown impact",
    )
    record = build_review_record(
        analysis_result=analysis,
        mitigation_result=mitigation,
        verifier_result=verification,
        cvss_result=cvss,
    )
    assert record.analysis.narratives[0] is analysis.narratives[0]
    assert record.mitigation.file_changes == mitigation.file_changes
    assert record.verification.overview == verification.overview
    assert record.cvss is not None
    assert record.cvss.not_scored_reason == "Unknown impact"
    restored = await pydantic_data_converter.decode(
        await pydantic_data_converter.encode([record]), [ReviewRecord]
    )
    assert restored == [record]
    public = record.model_dump(mode="json", by_alias=True)
    assert public["analysis"]["narratives"] == [
        item.model_dump(mode="json", by_alias=True) for item in analysis.narratives
    ]
    contract_validator("review-record.schema.json").validate(public)


def test_review_record_rejects_incomplete_narrative() -> None:
    with pytest.raises(ValidationError):
        ReviewRecord.model_validate({"analysis": {"narratives": [{"priority": 1}]}})


def test_review_record_builder_does_not_hide_invalid_stage_result_as_not_run() -> None:
    """Only None means a stage did not run; broken internal values must fail."""
    with pytest.raises(ValidationError):
        build_review_record(
            analysis_result="broken",  # type: ignore[arg-type]
            mitigation_result=None,
            verifier_result=None,
            cvss_result=None,
        )


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("analysis", "overview", 42),
        ("mitigation", "overview", 42),
        ("mitigation", "patch_diff", 42),
        ("verification", "overview", 42),
        ("verification", "review_target_claim", 42),
        ("verification", "validation_level", "invalid"),
        ("verification", "patch_coverage", "invalid"),
        ("verification", "regression_status", "invalid"),
        ("verification", "resolution_next_step", "invalid"),
        ("cvss", "outcome", "invalid"),
        ("cvss", "severity", 42),
        ("cvss", "vector", 42),
        ("cvss", "overview", 42),
        ("cvss", "not_scored_reason", 42),
        ("cvss", "base_score", True),
        ("cvss", "base_score", "8.1"),
    ],
)
def test_review_record_rejects_malformed_scalar_fields(section, field, value) -> None:
    with pytest.raises(ValidationError) as error:
        ReviewRecord.model_validate({section: {field: value}})
    assert error.value.errors()[0]["loc"] == (section, field)


@pytest.mark.parametrize(
    ("section", "field", "valid_item"),
    [
        ("mitigation", "file_changes", {"path": "app.py", "status": "deleted"}),
        ("verification", "patch_findings", "Finding"),
        ("verification", "verification_findings", "Finding"),
        ("verification", "residual_risks", "Risk"),
    ],
)
@pytest.mark.parametrize("malformed_container", [True, False])
def test_review_record_rejects_malformed_lists(
    section, field, valid_item, malformed_container
) -> None:
    """A damaged result must not become an empty or partially retained list."""
    value = None if malformed_container else [valid_item, 42]
    with pytest.raises(ValidationError) as error:
        ReviewRecord.model_validate({section: {field: value}})
    location = error.value.errors()[0]["loc"]
    assert location[:2] == (section, field)
    if not malformed_container:
        assert location[2] == 1


def test_review_record_builder_rejects_damaged_stage_field() -> None:
    """Projection must surface invalid internal data even after model validation."""
    mitigation = MitigationStageResult.model_construct(file_changes=[42])
    with pytest.raises(ValidationError) as error:
        build_review_record(
            analysis_result=None,
            mitigation_result=mitigation,
            verifier_result=None,
            cvss_result=None,
        )
    assert error.value.errors()[0]["loc"][:2] == ("file_changes", 0)
