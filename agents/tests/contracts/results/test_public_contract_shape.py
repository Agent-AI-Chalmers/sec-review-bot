from collections.abc import Mapping
from typing import Any

from sec_review_agents.review_stages.record import build_review_record
from sec_review_agents.workflows.repository.result import (
    build_repository_workflow_result,
)
from tests.contract_fixtures import contract_validator, format_schema_errors

FORBIDDEN_INTERNAL_PUBLIC_RESULT_KEYS = {
    "analysis_result",
    "analyzer_result",
    "blocked_case_summaries",
    "created_deliveries",
    "cvss_result",
    "delivery",
    "delivery_item",
    "delivery_plan_result",
    "feedback_retry",
    "mitigation_result",
    "mitigator_result",
    "patch_synthesis",
    "previews",
    "run_id",
    "single_agent_result",
    "stage_results",
    "verifier_result",
}

FORBIDDEN_INTERNAL_REVIEW_RECORD_KEYS = {
    "case_summary",
    "disposition",
    "raw",
    "strategy",
    "target",
}

FORBIDDEN_INTERNAL_MITIGATION_KEYS = {
    "patch_artifact_path",
}


def not_run_review_record() -> dict[str, Any]:
    return build_review_record(
        analysis_result=None,
        mitigation_result=None,
        verifier_result=None,
        cvss_result=None,
    )


def assert_public_workflow_result(result: Mapping[str, Any]) -> None:
    assert FORBIDDEN_INTERNAL_PUBLIC_RESULT_KEYS.intersection(result) == set()
    assert result.get("contract_version") == "v4"


def assert_review_record_shape(review_record: Mapping[str, Any]) -> None:
    for key in (
        "analysis",
        "mitigation",
        "verification",
    ):
        assert key in review_record
    assert FORBIDDEN_INTERNAL_REVIEW_RECORD_KEYS.intersection(review_record) == set()
    mitigation = review_record["mitigation"]
    assert isinstance(mitigation, Mapping)
    assert FORBIDDEN_INTERNAL_MITIGATION_KEYS.intersection(mitigation) == set()


def assert_matches_v4_schema(payload: Mapping[str, Any], schema_name: str) -> None:
    validator = contract_validator("v4", schema_name)
    errors = sorted(
        validator.iter_errors(payload),
        key=lambda error: list(error.path),
    )

    assert (
        errors == []
    ), f"{schema_name} validation failed:\n{format_schema_errors(errors)}"


def test_pull_request_result_public_shape() -> None:
    result: dict[str, Any] = {
        "contract_version": "v4",
        "review_record": build_review_record(
            analysis_result={
                "verdict": "no-actionable-finding",
                "narratives": [],
            },
            mitigation_result={
                "overview": "No target.",
                "changed_files": [],
                "file_changes": [],
            },
            verifier_result={
                "status": "completed",
                "patch_coverage": "not-applicable",
                "resolution_next_step": "manual-review",
                "verification_findings": [],
                "patch_findings": [],
                "residual_risks": [],
            },
            cvss_result=None,
        ),
    }

    assert_public_workflow_result(result)
    assert_review_record_shape(result["review_record"])


def test_review_record_builder_output_matches_shared_v4_schema() -> None:
    result = build_review_record(
        analysis_result={
            "verdict": "confirmed-vulnerability",
            "overview": "Webhook retry payloads can reuse stale signature metadata.",
            "narratives": [],
        },
        mitigation_result={
            "overview": "Recompute signature metadata before enqueueing retry payloads.",
            "changed_files": ["src/webhook.ts"],
            "file_changes": [
                {
                    "path": "src/webhook.ts",
                    "status": "upsert",
                    "content": "export const ok = true\n",
                    "content_encoding": "utf-8",
                }
            ],
            "patch_diff": "diff --git a/src/webhook.ts b/src/webhook.ts\n",
        },
        verifier_result={
            "overview": "The patch covers the retry enqueue path.",
            "review_target_claim": "Retry payloads must be signed with current metadata.",
            "validation_level": "static",
            "patch_coverage": "full",
            "regression_status": "not-run",
            "resolution_next_step": "none",
            "patch_findings": [],
            "verification_findings": [],
            "residual_risks": [],
        },
        cvss_result={
            "outcome": "scored",
            "base_score": 5.8,
            "severity": "medium",
            "vector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N",
            "overview": "Authenticated users can replay stale retry payloads.",
            "not_scored_reason": None,
        },
    )

    assert_matches_v4_schema(result, "review-record.schema.json")


def test_repository_result_public_shape() -> None:
    case_result = {
        "case_id": "case-1",
        "disposition": "keep",
        "reason": "ready",
        "review_record": {
            "analysis": {
                "verdict": "confirmed-vulnerability",
                "overview": "overview",
                "narratives": [],
            },
            "mitigation": {
                "overview": None,
                "changed_files": [],
                "patch_diff": None,
            },
            "verification": {
                "overview": None,
                "validation_level": None,
                "patch_coverage": None,
                "patch_findings": [],
                "verification_findings": [],
                "residual_risks": [],
            },
            "cvss": None,
        },
    }
    result = build_repository_workflow_result(
        discovery_result={},
        triage_result={},
        delivery_result={
            "deliveries": [{"delivery_id": "delivery-1"}],
            "caseDeliveryAssignments": {"case-1": {"status": "single"}},
            "case_delivery_assignments": {"case-1": {"status": "single"}},
        },
        case_results=[case_result],
    )

    assert_public_workflow_result(result)
    assert result["deliveries"] == [{"delivery_id": "delivery-1"}]
    assert "cases" not in result
    assert_review_record_shape(result["case_results"][0]["review_record"])


def test_repository_workflow_result_builder_output_matches_shared_v4_schema() -> None:
    result = build_repository_workflow_result(
        discovery_result={
            "counts": {
                "scannable_file_count": 12,
                "scanned_file_count": 12,
                "skipped_file_count": 0,
                "candidate_count": 2,
            }
        },
        triage_result={
            "counts": {
                "case_count": 1,
                "suppressed_candidate_count": 1,
            }
        },
        delivery_result={
            "deliveries": [
                {
                    "delivery_id": "delivery-1",
                    "case_ids": ["case-1"],
                    "file_changes": [
                        {
                            "path": "src/webhook.ts",
                            "status": "upsert",
                            "content": "export const ok = true\n",
                            "content_encoding": "utf-8",
                        }
                    ],
                }
            ],
        },
        case_results=[
            {
                "case_id": "case-1",
                "disposition": "keep",
                "reason": None,
                "review_record": build_review_record(
                    analysis_result={
                        "verdict": "confirmed-vulnerability",
                        "overview": "Webhook retry payloads can reuse stale metadata.",
                        "narratives": [],
                    },
                    mitigation_result={
                        "overview": "Recompute signature metadata before enqueueing.",
                        "changed_files": ["src/webhook.ts"],
                        "file_changes": [],
                        "patch_diff": "diff --git a/src/webhook.ts b/src/webhook.ts\n",
                    },
                    verifier_result={
                        "overview": "The patch covers the retry enqueue path.",
                        "review_target_claim": (
                            "Retry payloads must be signed with current metadata."
                        ),
                        "validation_level": "static",
                        "patch_coverage": "full",
                        "regression_status": "not-run",
                        "resolution_next_step": "none",
                        "patch_findings": [],
                        "verification_findings": [],
                        "residual_risks": [],
                    },
                    cvss_result={
                        "outcome": "scored",
                        "base_score": 5.8,
                        "severity": "medium",
                        "vector": "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N",
                        "overview": "Authenticated users can replay stale retry payloads.",
                        "not_scored_reason": None,
                    },
                ),
            }
        ],
    )

    assert_matches_v4_schema(result, "repository-review-result.schema.json")


def test_repository_case_results_drop_internal_case_fields() -> None:
    case_result = {
        "case_id": "case-1",
        "disposition": "keep",
        "reason": "ready",
        "review_record": {
            "strategy": {"name": "default", "stages": ["analysis"]},
            "analysis": {},
            "raw": {"internal": True},
        },
        "deliveryAssignment": {"delivery_id": "delivery-1"},
        "delivery_assignment": {"delivery_id": "delivery-1"},
        "case": {"case_id": "case-1"},
        "case_summary": {"case_id": "case-1"},
        "unexpectedInternalState": True,
        "unexpected_internal_state": True,
    }

    result = build_repository_workflow_result(
        discovery_result={},
        triage_result={},
        delivery_result=None,
        case_results=[case_result],
    )

    assert set(result["case_results"][0]) == {
        "case_id",
        "disposition",
        "reason",
        "review_record",
    }
    assert "delivery_assignment" not in result["case_results"][0]
    assert "unexpected_internal_state" not in result["case_results"][0]
    assert "strategy" not in result["case_results"][0]["review_record"]
    assert "raw" not in result["case_results"][0]["review_record"]


def test_repository_case_results_normalize_partial_review_record_shape() -> None:
    result = build_repository_workflow_result(
        discovery_result={},
        triage_result={},
        delivery_result=None,
        case_results=[
            {
                "case_id": "case-1",
                "disposition": "keep",
                "reason": None,
                "review_record": {
                    "analysis": {
                        "verdict": "confirmed-defect",
                        "unexpected": "dropped",
                    },
                },
            }
        ],
    )

    review_record = result["case_results"][0]["review_record"]
    assert review_record["analysis"]["verdict"] == "confirmed-defect"
    assert review_record["analysis"]["overview"] is None
    assert review_record["mitigation"]["changed_files"] == []
    assert review_record["verification"]["patch_coverage"] is None
    assert review_record["cvss"] is None
    assert "unexpected" not in review_record["analysis"]


def test_repository_case_result_reason_is_always_present_and_nullable() -> None:
    result = build_repository_workflow_result(
        discovery_result={},
        triage_result={},
        delivery_result=None,
        case_results=[
            {
                "case_id": "case-1",
                "disposition": "blocked",
                "review_record": not_run_review_record(),
            },
            {
                "case_id": "case-2",
                "disposition": "blocked",
                "reason": "  needs manual review  ",
                "review_record": not_run_review_record(),
            },
        ],
    )

    assert result["case_results"][0]["reason"] is None
    assert result["case_results"][1]["reason"] == "needs manual review"


def test_repository_blocked_case_result_keeps_required_review_record() -> None:
    result = build_repository_workflow_result(
        discovery_result={},
        triage_result={},
        delivery_result=None,
        case_results=[
            {
                "case_id": "case-1",
                "disposition": "blocked",
                "reason": "case processing failed",
                "review_record": not_run_review_record(),
            },
        ],
    )

    assert set(result["case_results"][0]) == {
        "case_id",
        "disposition",
        "reason",
        "review_record",
    }
    review_record = result["case_results"][0]["review_record"]
    assert review_record["analysis"]["verdict"] is None
    assert review_record["mitigation"]["changed_files"] == []
    assert review_record["verification"]["patch_coverage"] is None
    assert review_record["cvss"] is None
