import json
from annotationlib import Format, get_annotations
from typing import Any

import sec_review_agents.delivery_stages.result as delivery_result_module
from sec_review_agents.delivery_stages.execution.patch_synthesis import (
    synthesize_combined_delivery_patch,
)
from sec_review_agents.delivery_stages.execution.result import (
    build_delivery_execution_result,
)
from sec_review_agents.delivery_stages.model import (
    DeliveryEntry,
    DeliveryPlan,
)
from sec_review_agents.delivery_stages.planning.stage import (
    generate_delivery_plan,
)
from sec_review_agents.delivery_stages.result import (
    build_delivery_result_from_outcomes,
    build_skipped_delivery_result,
    persist_delivery_result,
)
from sec_review_agents.workspace.file_changes import FileChange


def test_delivery_plan_return_annotation_is_public_payload() -> None:
    assert (
        get_annotations(generate_delivery_plan, format=Format.VALUE)["return"]
        == dict[str, Any]
    )


def test_delivery_plan_tracks_required_sections() -> None:
    assert DeliveryPlan.__required_keys__ == {
        "status",
        "metadata",
        "counts",
        "deliveries",
    }
    assert DeliveryEntry.__required_keys__ == {
        "delivery_id",
        "strategy",
        "case_ids",
        "reason",
    }


def test_delivery_result_builder_return_annotation_is_public_payload() -> None:
    assert (
        get_annotations(build_delivery_result_from_outcomes, format=Format.VALUE)[
            "return"
        ]
        == dict[str, Any]
    )


def test_delivery_result_module_exports_result_helpers_only() -> None:
    assert set(delivery_result_module.__all__) == {
        "build_delivery_result_from_outcomes",
        "build_skipped_delivery_result",
        "persist_delivery_result",
    }


def test_delivery_execution_result_return_annotation_is_public_payload() -> None:
    assert (
        get_annotations(synthesize_combined_delivery_patch, format=Format.VALUE)[
            "return"
        ]
        == dict[str, Any]
    )


def test_delivery_result_contract_tracks_required_sections(tmp_path) -> None:
    result = build_delivery_result_from_outcomes(
        deliveries=[
            {
                "delivery_id": "delivery-1",
                "strategy": "single",
                "case_ids": ["case-1"],
                "reason": "single case",
            }
        ],
        keep_case_ids=["case-1"],
        patch_outcomes=[
            {
                "delivery_id": "delivery-1",
                "status": "ready",
                "error": None,
                "patch_path": None,
                "patch_diff": "",
                "changed_files": ["src/app.py"],
                "file_changes": [{"path": "src/app.py", "status": "modified"}],
                "applied_case_ids": ["case-1"],
            }
        ],
    )

    assert set(result) == {
        "status",
        "deliveries",
    }
    assert len(result["deliveries"]) == 1
    assert set(result["deliveries"][0]) == {
        "delivery_id",
        "case_ids",
        "file_changes",
    }


def test_delivery_execution_result_builder_tracks_public_fields() -> None:
    result = build_delivery_execution_result(
        delivery_id="delivery-1",
        status="ready",
        error=None,
        patch_path=None,
        patch_diff="",
        changed_files=[],
        file_changes=[],
        applied_case_ids=["case-1"],
    )

    assert set(result) == {
        "delivery_id",
        "status",
        "error",
        "patch_path",
        "patch_diff",
        "changed_files",
        "file_changes",
        "applied_case_ids",
    }


def test_delivery_execution_result_is_json_serializable_public_payload() -> None:
    result = build_delivery_execution_result(
        delivery_id="delivery-1",
        status="ready",
        error=None,
        patch_path=None,
        patch_diff="",
        changed_files=[],
        file_changes=[],
        applied_case_ids=["case-1"],
    )

    assert type(result) is dict
    json.dumps(result)
    assert FileChange.__required_keys__ == set()
    assert FileChange.__optional_keys__ == {
        "path",
        "status",
        "content",
        "content_encoding",
        "mode",
    }


def test_delivery_result_builders_emit_json_serializable_public_payloads() -> None:
    completed = build_delivery_result_from_outcomes(
        deliveries=[
            {
                "delivery_id": "delivery-1",
                "strategy": "single",
                "case_ids": ["case-1"],
                "reason": "single case",
            }
        ],
        keep_case_ids=["case-1"],
        patch_outcomes=[
            {
                "delivery_id": "delivery-1",
                "status": "ready",
                "error": None,
                "patch_path": None,
                "patch_diff": "",
                "changed_files": ["src/app.py"],
                "file_changes": [{"path": "src/app.py", "status": "modified"}],
                "applied_case_ids": ["case-1"],
            }
        ],
    )
    skipped = build_skipped_delivery_result()

    for result in (completed, skipped):
        assert type(result) is dict
        json.dumps(result)


def test_delivery_result_persistence_writes_stage_artifacts(tmp_path) -> None:
    result = build_delivery_result_from_outcomes(
        deliveries=[
            {
                "delivery_id": "delivery-1",
                "strategy": "single",
                "case_ids": ["case-1"],
                "reason": "single case",
            }
        ],
        keep_case_ids=["case-1"],
        patch_outcomes=[
            {
                "delivery_id": "delivery-1",
                "status": "ready",
                "error": None,
                "patch_path": None,
                "patch_diff": "",
                "changed_files": ["src/app.py"],
                "file_changes": [{"path": "src/app.py", "status": "modified"}],
                "applied_case_ids": ["case-1"],
            }
        ],
    )

    persist_delivery_result(run_artifacts_root=tmp_path, result=result)

    result_path = tmp_path / "delivery-execution" / "delivery-result.json"
    artifact_path = tmp_path / "delivery-execution" / "artifacts" / "delivery-1.json"
    assert json.loads(result_path.read_text(encoding="utf-8")) == result
    assert (
        json.loads(artifact_path.read_text(encoding="utf-8")) == result["deliveries"][0]
    )


def test_skipped_delivery_result_persistence_writes_stage_result(tmp_path) -> None:
    result = build_skipped_delivery_result()

    persist_delivery_result(run_artifacts_root=tmp_path, result=result)

    result_path = tmp_path / "delivery-execution" / "delivery-result.json"
    assert json.loads(result_path.read_text(encoding="utf-8")) == result
    assert not (tmp_path / "delivery-execution" / "artifacts").exists()
