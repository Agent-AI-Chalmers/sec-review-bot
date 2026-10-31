import json
from annotationlib import Format, get_annotations

import pytest

from sec_review_agents.review_stages.analysis.result import (
    AnalysisStageResult,
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
        get_annotations(build_mitigation_stage_result, format=Format.VALUE)["return"]
        == MitigationStageResult
    )
    assert (
        get_annotations(build_verification_stage_result, format=Format.VALUE)["return"]
        == VerificationStageResult
    )


def test_stage_result_compiler_models_track_public_fields() -> None:
    assert set(AnalysisStageResult.model_fields) == {
        "overview",
        "narratives",
        "verdict",
    }
    assert set(MitigationStageResult.model_fields) == {
        "overview",
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
    )

    assert result.file_changes == []
    assert result.patch_diff == ""


def test_stage_result_builders_emit_json_serializable_public_payloads() -> None:
    results = [
        AnalysisStageResult(
            overview="Analysis complete.",
            narratives=[],
            verdict="confirmed-defect",
        ).model_dump(mode="json", by_alias=True),
        build_mitigation_stage_result(
            overview="Patched input validation.",
            file_changes=[{"path": "src/app.py", "status": "deleted"}],
        ).model_dump(mode="json"),
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
        ).model_dump(mode="json"),
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

    assert result.review_target_claim is None


def test_scan_stage_entrypoint_return_annotation_is_named_contract() -> None:
    assert (
        get_annotations(run_repository_triage_stage, format=Format.VALUE)["return"]
        is TriageResult
    )


def test_scan_stage_contracts_track_required_sections() -> None:
    assert set(DiscoveryResult.model_fields) == {
        "status",
        "metadata",
        "counts",
        "files",
        "skipped_files",
        "candidates",
    }
    assert set(DiscoveryFileResult.model_fields) == {
        "path",
        "language",
        "size_bytes",
        "candidate_count",
    }
    assert {
        name for name, field in TriageResult.model_fields.items() if field.is_required()
    } == {
        "status",
        "metadata",
        "counts",
        "cases",
        "suppressed_candidates",
    }


def test_analysis_stage_preserves_nested_narrative_models_in_json() -> None:
    from sec_review_agents.agents.analysis.model import Narrative

    narrative = Narrative.model_validate(
        {
            "priority": 1,
            "verdict": "confirmed-defect",
            "title": "Unchecked state",
            "description": "The transition skips a required check.",
            "locations": [{"file": "app.py", "line": 3}],
            "scope_review": {
                "scope_shape": "unresolved",
                "outcome_deciding_control_point": "transition",
                "scope_analysis": "Checked the transition.",
            },
        }
    )
    result = AnalysisStageResult(
        overview="Defect found.", narratives=[narrative], verdict="confirmed-defect"
    )
    assert result.narratives[0] is narrative
    assert result.model_dump(mode="json", by_alias=True)["narratives"] == [
        narrative.model_dump(mode="json", by_alias=True)
    ]
    json.dumps(result.model_dump(mode="json", by_alias=True))


@pytest.mark.asyncio
async def test_triage_artifact_preserves_file_only_anchors_and_nullable_metadata(
    tmp_path, monkeypatch
) -> None:
    """Replay JSON omits absent anchor lines while keeping nullable stage metadata."""
    from unittest.mock import AsyncMock

    from sec_review_agents.agents.discovery.model import (
        DiscoveryCandidate,
        DiscoveryLocation,
    )
    from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult
    from tests.repository_scan_fixtures import scan_result_fixture

    scan = scan_result_fixture(candidate_count=1, case_count=1)
    location = DiscoveryLocation(file="src/routes.py", label="route")
    scan.discovery_result.candidates = [
        DiscoveryCandidateResult(
            candidate_id="candidate-1",
            candidate=DiscoveryCandidate(
                category="xss",
                description="Route signal",
                locations=[location],
                evidence=[],
            ),
            grounding_status="needs-grounding",
        )
    ]
    scan.triage_result.cases[0].anchor_locations = [location]
    monkeypatch.setattr(
        "sec_review_agents.scan_stages.triage.agent_passes.run_repository_triage_agent",
        AsyncMock(return_value=scan.triage_result),
    )
    result = await run_repository_triage_stage(
        triage_root=tmp_path, discovery_result=scan.discovery_result
    )
    artifact = json.loads((tmp_path / "triage-result.json").read_text())
    assert artifact["cases"][0]["anchor_locations"] == [
        {"file": "src/routes.py", "label": "route"}
    ]
    assert artifact["metadata"]["batch_size"] is None
    assert TriageResult.model_validate(artifact) == result
