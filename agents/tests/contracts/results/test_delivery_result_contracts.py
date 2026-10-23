import json
from annotationlib import Format, get_annotations
from typing import Any, get_args, get_type_hints

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
from sec_review_agents.workspace.file_changes import (
    DeletedFileChange,
    UpsertFileChange,
)
from tests.contract_fixtures import contract_schema


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
                "patch_diff": "",
                "changed_files": ["src/app.py"],
                "file_changes": [
                    {
                        "path": "src/app.py",
                        "status": "upsert",
                        "content": "print('ok')\n",
                        "content_encoding": "utf-8",
                    }
                ],
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
        "patch_diff",
    }


def test_delivery_execution_result_builder_tracks_public_fields() -> None:
    result = build_delivery_execution_result(
        delivery_id="delivery-1",
        status="ready",
        error=None,
        patch_diff="",
        file_changes=[],
    )

    assert set(result) == {
        "delivery_id",
        "status",
        "error",
        "patch_diff",
        "file_changes",
    }


def test_file_change_types_match_shared_schema() -> None:
    variants = contract_schema("common.schema.json")["$defs"]["fileChange"]["oneOf"]
    by_status = {
        variant["properties"]["status"]["const"]: variant for variant in variants
    }
    assert set(by_status) == {"deleted", "upsert"}

    deleted_schema = by_status["deleted"]
    assert DeletedFileChange.__required_keys__ == set(deleted_schema["required"])
    assert DeletedFileChange.__optional_keys__ == set(
        deleted_schema["properties"]
    ) - set(deleted_schema["required"])
    deleted_annotations = get_type_hints(DeletedFileChange)
    assert set(get_args(deleted_annotations["status"])) == {"deleted"}

    upsert_schema = by_status["upsert"]
    assert UpsertFileChange.__required_keys__ == set(upsert_schema["required"])
    assert UpsertFileChange.__optional_keys__ == set(upsert_schema["properties"]) - set(
        upsert_schema["required"]
    )
    upsert_annotations = get_type_hints(UpsertFileChange)
    assert set(get_args(upsert_annotations["status"])) == {"upsert"}

    upsert_properties = upsert_schema["properties"]
    content_encoding = getattr(
        upsert_annotations["content_encoding"],
        "__value__",
        upsert_annotations["content_encoding"],
    )
    mode = getattr(upsert_annotations["mode"], "__value__", upsert_annotations["mode"])
    assert set(get_args(content_encoding)) == set(
        upsert_properties["content_encoding"]["enum"]
    )
    assert set(get_args(mode)) == set(upsert_properties["mode"]["enum"])


def test_delivery_execution_result_is_json_serializable_public_payload() -> None:
    result = build_delivery_execution_result(
        delivery_id="delivery-1",
        status="ready",
        error=None,
        patch_diff="",
        file_changes=[],
    )

    assert type(result) is dict
    json.dumps(result)


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
                "patch_diff": "",
                "changed_files": ["src/app.py"],
                "file_changes": [
                    {
                        "path": "src/app.py",
                        "status": "upsert",
                        "content": "print('ok')\n",
                        "content_encoding": "utf-8",
                    }
                ],
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
                "patch_diff": "",
                "changed_files": ["src/app.py"],
                "file_changes": [
                    {
                        "path": "src/app.py",
                        "status": "upsert",
                        "content": "print('ok')\n",
                        "content_encoding": "utf-8",
                    }
                ],
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
