import json
from annotationlib import Format, get_annotations
from typing import Any

from sec_review_agents.review_stages.analysis.result import (
    AnalysisStageResult,
    build_analysis_stage_result,
)
from sec_review_agents.review_stages.mitigation.result import (
    MitigationStageResult,
    build_mitigation_stage_result,
)
from sec_review_agents.review_stages.verification.result import (
    VerificationStageResult,
    build_verification_stage_result,
)
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryFileResult,
    DiscoveryResult,
)
from sec_review_agents.scan_stages.triage.result import (
    TriageResult,
)
from sec_review_agents.scan_stages.triage.stage import run_repository_triage_stage


def test_stage_result_builder_return_annotations_are_public_payloads() -> None:
    assert (
        get_annotations(build_analysis_stage_result, format=Format.VALUE)["return"]
        == dict[str, Any]
    )
    assert (
        get_annotations(build_mitigation_stage_result, format=Format.VALUE)["return"]
        == dict[str, Any]
    )
    assert (
        get_annotations(build_verification_stage_result, format=Format.VALUE)["return"]
        == dict[str, Any]
    )


def test_stage_result_compiler_models_track_public_fields() -> None:
    assert set(AnalysisStageResult.model_fields) == {
        "overview",
        "narratives",
        "verdict",
    }
    assert set(MitigationStageResult.model_fields) == {
        "overview",
        "changed_files",
        "file_changes",
        "patch_diff",
    }
    assert set(VerificationStageResult.model_fields) == {
        "overview",
        "review_target_claim",
        "patch_coverage",
        "resolution_next_step",
        "patch_findings",
        "verification_findings",
        "validation_level",
        "regression_status",
        "residual_risks",
    }


def test_mitigation_stage_builder_emits_required_file_changes() -> None:
    result = build_mitigation_stage_result(
        overview="No mitigation target.",
        changed_files=[],
    )

    assert result["file_changes"] == []
    assert result["patch_diff"] == ""


def test_stage_result_builders_emit_json_serializable_public_payloads() -> None:
    results = [
        build_analysis_stage_result(
            overview="Analysis complete.",
            narratives=[{"summary": "checked"}],
            verdict="confirmed-defect",
        ),
        build_mitigation_stage_result(
            overview="Patched input validation.",
            changed_files=["src/app.py"],
        ),
        build_verification_stage_result(
            overview="Patch covers the target claim.",
            review_target_claim="Input is validated before use.",
            patch_coverage="full",
            resolution_next_step="none",
            patch_findings=[],
            verification_findings=["Reviewed patched branch."],
            validation_level="static",
            regression_status="not-run",
            residual_risks=[],
        ),
    ]

    for result in results:
        assert type(result) is dict
        json.dumps(result)


def test_verification_stage_builder_keeps_nullable_public_fields() -> None:
    result = build_verification_stage_result(
        overview="No patch was available.",
        review_target_claim=None,
        patch_coverage="no-patch",
        resolution_next_step="manual-review",
        patch_findings=[],
        verification_findings=[],
        validation_level="static",
        regression_status="not-applicable",
        residual_risks=[],
    )

    assert result["review_target_claim"] is None


def test_scan_stage_entrypoint_return_annotation_is_named_contract() -> None:
    assert (
        get_annotations(run_repository_triage_stage, format=Format.VALUE)["return"]
        is TriageResult
    )


def test_scan_stage_contracts_track_required_sections() -> None:
    assert DiscoveryResult.__required_keys__ == {
        "status",
        "metadata",
        "counts",
        "files",
        "skipped_files",
        "candidates",
    }
    assert DiscoveryFileResult.__required_keys__ == {
        "path",
        "language",
        "size_bytes",
        "candidate_count",
    }
    assert TriageResult.__required_keys__ == {
        "status",
        "metadata",
        "counts",
        "cases",
        "suppressed_candidates",
    }
