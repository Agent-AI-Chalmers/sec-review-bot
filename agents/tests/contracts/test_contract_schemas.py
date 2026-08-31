from copy import deepcopy

import pytest

from tests.contract_fixtures import (
    contract_fixture,
    contract_fixture_files,
    contract_fixture_manifest,
    contract_schema_files,
    contract_validator,
    format_schema_errors,
)


def fixture_schemas(version: str) -> dict[str, str]:
    schema_fixtures = contract_fixture_manifest(version).get("schema_fixtures")
    assert isinstance(schema_fixtures, dict)
    assert all(
        isinstance(fixture_name, str) and isinstance(schema_name, str)
        for fixture_name, schema_name in schema_fixtures.items()
    )
    return schema_fixtures


def test_v4_contract_fixture_manifest_covers_fixture_and_schema_files() -> None:
    schema_fixtures = fixture_schemas("v4")
    fixture_names = {
        fixture_file.name
        for fixture_file in contract_fixture_files("v4")
        if fixture_file.name != "manifest.json"
    }
    schema_names = {schema_file.name for schema_file in contract_schema_files("v4")}

    assert set(schema_fixtures) == fixture_names
    assert set(schema_fixtures.values()) <= schema_names


def test_v4_contract_fixtures_match_json_schemas() -> None:
    for fixture_name, schema_name in fixture_schemas("v4").items():
        validator = contract_validator("v4", schema_name)
        errors = sorted(
            validator.iter_errors(contract_fixture("v4", fixture_name)),
            key=lambda error: list(error.path),
        )

        assert (
            errors == []
        ), f"{fixture_name} failed {schema_name}:\n{format_schema_errors(errors)}"


def test_v4_pull_request_input_schema_requires_audit_objective() -> None:
    validator = contract_validator("v4", "pull-request-review-input.schema.json")
    payload = contract_fixture("v4", "pull-request-review-input.json")
    payload["review_intent"]["objective"] = "repair"

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v4_repository_input_schema_requires_audit_objective() -> None:
    validator = contract_validator("v4", "repository-review-input.schema.json")
    payload = contract_fixture("v4", "repository-review-input-incremental.json")
    payload["review_intent"]["objective"] = "repair"

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v4_repository_full_scan_schema_rejects_incremental_window_fields() -> None:
    validator = contract_validator("v4", "repository-review-input.schema.json")
    payload = contract_fixture("v4", "repository-review-input-full.json")
    payload["scan_target"]["base_sha"] = "1111111111111111111111111111111111111111"
    payload["scan_target"]["commit_shas"] = ["1111111111111111111111111111111111111111"]
    payload["scan_scope"]["incremental_changed_files"] = [
        {"path": "src/webhook.ts", "status": "modified", "previous_path": None}
    ]

    errors = list(validator.iter_errors(payload))

    assert errors != []


@pytest.mark.parametrize(
    "scan_target_patch",
    [
        {"base_sha": None},
        {"commit_shas": []},
    ],
)
def test_v4_repository_incremental_schema_rejects_missing_window_fields(
    scan_target_patch: dict[str, object],
) -> None:
    validator = contract_validator("v4", "repository-review-input.schema.json")
    payload = deepcopy(
        contract_fixture("v4", "repository-review-input-incremental.json")
    )
    payload["scan_target"].update(scan_target_patch)

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v4_repository_incremental_schema_allows_empty_changed_file_scope() -> None:
    validator = contract_validator("v4", "repository-review-input.schema.json")
    payload = deepcopy(
        contract_fixture("v4", "repository-review-input-incremental.json")
    )
    payload["scan_scope"]["incremental_changed_files"] = []

    errors = list(validator.iter_errors(payload))

    assert errors == []


def test_v4_review_record_schema_rejects_unsafe_file_change_paths() -> None:
    validator = contract_validator("v4", "review-record.schema.json")
    payload = deepcopy(contract_fixture("v4", "review-record-deleted-file.json"))

    for path in [
        "../src/server.ts",
        "/src/server.ts",
        "C:src/server.ts",
        "C:/src/server.ts",
        "src//server.ts",
        "src\\server.ts",
        ".git/config",
        " src/server.ts ",
    ]:
        payload["mitigation"]["file_changes"][0]["path"] = path
        errors = list(validator.iter_errors(payload))

        assert errors != [], f"{path} should not be schema-valid"
