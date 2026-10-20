from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from sec_review_agents.entrypoints import contract_schema
from sec_review_agents.entrypoints.contract_schema import (
    CONTRACT_VERSION,
    validate_v6_workflow_result,
)
from tests.contract_fixtures import (
    contract_fixture,
    contract_fixture_files,
    contract_fixture_manifest,
    contract_schema_files,
    contract_validator,
    format_schema_errors,
)


def fixture_schemas() -> dict[str, str]:
    schema_fixtures = contract_fixture_manifest().get("schema_fixtures")
    assert isinstance(schema_fixtures, dict)
    assert all(
        isinstance(fixture_name, str) and isinstance(schema_name, str)
        for fixture_name, schema_name in schema_fixtures.items()
    )
    return schema_fixtures


def invalid_fixture_schemas() -> dict[str, str]:
    schema_fixtures = contract_fixture_manifest().get("invalid_schema_fixtures")
    assert isinstance(schema_fixtures, dict)
    return schema_fixtures


def test_v6_contract_fixture_manifest_covers_fixture_and_schema_files() -> None:
    schema_fixtures = fixture_schemas()
    fixture_names = {
        fixture_file.name
        for fixture_file in contract_fixture_files()
        if fixture_file.name != "manifest.json"
    }
    schema_names = {schema_file.name for schema_file in contract_schema_files()}

    invalid_schema_fixtures = invalid_fixture_schemas()
    assert set(schema_fixtures) | set(invalid_schema_fixtures) == fixture_names
    assert (
        set(schema_fixtures.values()) | set(invalid_schema_fixtures.values())
        <= schema_names
    )


def test_v6_contract_fixtures_match_json_schemas() -> None:
    for fixture_name, schema_name in fixture_schemas().items():
        validator = contract_validator(schema_name)
        errors = sorted(
            validator.iter_errors(contract_fixture(fixture_name)),
            key=lambda error: list(error.path),
        )

        assert (
            errors == []
        ), f"{fixture_name} failed {schema_name}:\n{format_schema_errors(errors)}"


@pytest.mark.parametrize(
    ("workflow", "fixture_name"),
    [
        ("issue-review", "issue-review-result.json"),
        ("pull-request-review", "pull-request-review-result.json"),
        ("repository-review", "repository-review-result.json"),
    ],
)
def test_runner_accepts_shared_v6_workflow_result_fixtures(
    workflow: str, fixture_name: str
) -> None:
    validate_v6_workflow_result(contract_fixture(fixture_name), workflow)


def test_runner_rejects_result_missing_required_fields() -> None:
    with pytest.raises(ValueError, match="Runner result does not match contract"):
        validate_v6_workflow_result(
            {"contract_version": CONTRACT_VERSION},
            "issue-review",
        )


def invalid_fixture_error_paths() -> dict[str, str]:
    error_paths = contract_fixture_manifest().get("invalid_fixture_error_paths")
    assert isinstance(error_paths, dict)
    return error_paths


def test_v6_invalid_contract_fixtures_fail_where_their_name_says() -> None:
    """Each invalid fixture must isolate the rule its name states.

    "It was rejected" is too weak: a fixture that also violates an unrelated required field
    passes even when the rule under test stops being enforced, because the schema still rejects
    it for the other reason. Pinning the failing location is what keeps each fixture measuring
    one rule.
    """
    error_paths = invalid_fixture_error_paths()
    invalid = invalid_fixture_schemas()
    assert set(error_paths) == set(
        invalid
    ), "every invalid fixture must declare where it is expected to fail"

    for fixture_name, schema_name in invalid.items():
        validator = contract_validator(schema_name)

        errors = sorted(
            validator.iter_errors(contract_fixture(fixture_name)),
            key=lambda error: list(error.path),
        )
        assert errors != [], f"{fixture_name} unexpectedly matched {schema_name}"

        expected = error_paths[fixture_name]
        failing = {
            ".".join(str(part) for part in error.absolute_path) or "<root>"
            for error in errors
        }
        assert failing == {
            expected
        }, f"{fixture_name} should fail only at {expected}, but failed at {sorted(failing)}"


@pytest.mark.parametrize("value", ["allow", "deny"])
def test_v6_issue_input_schema_accepts_test_changes(value: str) -> None:
    validator = contract_validator("issue-review-input.schema.json")
    payload = contract_fixture("issue-review-input.json")
    payload["review_intent"]["test_changes"] = value

    errors = list(validator.iter_errors(payload))

    assert errors == []


def test_v6_issue_input_schema_rejects_test_changes_outside_enum() -> None:
    validator = contract_validator("issue-review-input.schema.json")
    payload = contract_fixture("issue-review-input.json")
    payload["review_intent"]["test_changes"] = "no-test-changes"

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v6_issue_input_schema_rejects_renamed_repair_mode_field() -> None:
    # reviewIntent sets additionalProperties: false, so the field the rename replaced
    # must not validate under its old name.
    validator = contract_validator("issue-review-input.schema.json")
    payload = contract_fixture("issue-review-input.json")
    payload["review_intent"]["repair_mode"] = "no-test-changes"

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v6_pull_request_input_schema_requires_audit_objective() -> None:
    validator = contract_validator("pull-request-review-input.schema.json")
    payload = contract_fixture("pull-request-review-input.json")
    payload["review_intent"]["objective"] = "repair"

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v6_repository_input_schema_requires_audit_objective() -> None:
    validator = contract_validator("repository-review-input.schema.json")
    payload = contract_fixture("repository-review-input-incremental.json")
    payload["review_intent"]["objective"] = "repair"

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v6_repository_full_scan_schema_rejects_incremental_window_fields() -> None:
    validator = contract_validator("repository-review-input.schema.json")
    payload = contract_fixture("repository-review-input-full.json")
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
def test_v6_repository_incremental_schema_rejects_missing_window_fields(
    scan_target_patch: dict[str, object],
) -> None:
    validator = contract_validator("repository-review-input.schema.json")
    payload = deepcopy(contract_fixture("repository-review-input-incremental.json"))
    payload["scan_target"].update(scan_target_patch)

    errors = list(validator.iter_errors(payload))

    assert errors != []


def test_v6_repository_incremental_schema_allows_empty_changed_file_scope() -> None:
    validator = contract_validator("repository-review-input.schema.json")
    payload = deepcopy(contract_fixture("repository-review-input-incremental.json"))
    payload["scan_scope"]["incremental_changed_files"] = []

    errors = list(validator.iter_errors(payload))

    assert errors == []


def test_v6_review_record_schema_rejects_unsafe_file_change_paths() -> None:
    validator = contract_validator("review-record.schema.json")
    payload = deepcopy(contract_fixture("review-record-deleted-file.json"))

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


def test_contracts_root_env_var_is_authoritative(monkeypatch, tmp_path: Path) -> None:
    # A set root must be used as-is: the operator names where the schemas are.
    schemas = (
        tmp_path
        / "integration-contract"
        / contract_schema.CONTRACT_VERSION_DIR
        / "schemas"
    )
    schemas.mkdir(parents=True)
    (schemas / "common.schema.json").write_text("{}", encoding="utf-8")

    monkeypatch.setenv("SEC_REVIEW_CONTRACTS_ROOT", str(tmp_path))
    assert contract_schema._schema_root() == schemas


def test_contracts_root_env_var_that_lacks_schemas_fails_loudly(
    monkeypatch, tmp_path: Path
) -> None:
    # A set-but-wrong root is a misconfiguration, not a reason to silently read some other
    # copy: the resolver must reject it rather than fall through to the source layout.
    monkeypatch.setenv("SEC_REVIEW_CONTRACTS_ROOT", str(tmp_path))
    with pytest.raises(RuntimeError, match="SEC_REVIEW_CONTRACTS_ROOT"):
        contract_schema._schema_root()


# The fixture and the schema it validates against are separate names; resolve the schema from the
# manifest instead of restating it here.
_REPOSITORY_INCREMENTAL_SCHEMA = fixture_schemas()[
    "repository-review-input-incremental.json"
]


def _repository_input_with_changed_files(
    changed_files: list[dict[str, Any]],
) -> dict[str, Any]:
    fixture = deepcopy(contract_fixture("repository-review-input-incremental.json"))
    scan_scope = fixture["scan_scope"]
    assert isinstance(scan_scope, dict)
    scan_scope["incremental_changed_files"] = changed_files
    return fixture


@pytest.mark.parametrize(
    "status",
    ["added", "modified", "deleted", "renamed", "copied", "type_changed"],
)
def test_v6_incremental_changed_file_accepts_every_contract_status(
    status: str,
) -> None:
    """The scan scope's status is a closed vocabulary, and every value in it must validate.

    A producer that gains a status the schema has not accepted would otherwise be silently
    downgraded, which is how `removed` reached discovery while it was waiting for `deleted`.
    """
    previous_path = "old.py" if status in {"renamed", "copied"} else None
    fixture = _repository_input_with_changed_files(
        [{"path": "new.py", "status": status, "previous_path": previous_path}]
    )

    errors = list(
        contract_validator(_REPOSITORY_INCREMENTAL_SCHEMA).iter_errors(fixture)
    )

    assert errors == [], format_schema_errors(errors)


@pytest.mark.parametrize("status", ["removed", "Renamed", "unknown", ""])
def test_v6_incremental_changed_file_rejects_status_outside_the_contract(
    status: str,
) -> None:
    """Upstream vocabulary must not travel as-is.

    `removed` is the GitHub compare API's word for a deletion; carrying it into the scan scope
    made discovery scan a file that no longer exists.
    """
    fixture = _repository_input_with_changed_files(
        [{"path": "new.py", "status": status, "previous_path": None}]
    )

    errors = list(
        contract_validator(_REPOSITORY_INCREMENTAL_SCHEMA).iter_errors(fixture)
    )

    assert errors, f"status {status!r} was accepted"


@pytest.mark.parametrize("status", ["renamed", "copied"])
def test_v6_incremental_changed_file_requires_previous_path_for_a_move(
    status: str,
) -> None:
    fixture = _repository_input_with_changed_files(
        [{"path": "new.py", "status": status, "previous_path": None}]
    )

    errors = list(
        contract_validator(_REPOSITORY_INCREMENTAL_SCHEMA).iter_errors(fixture)
    )

    assert errors, f"status {status!r} was accepted without a previous path"


@pytest.mark.parametrize("status", ["added", "modified", "deleted", "type_changed"])
def test_v6_incremental_changed_file_rejects_previous_path_without_a_move(
    status: str,
) -> None:
    """Only a move has a source path; on any other status it would be a meaningless field."""
    fixture = _repository_input_with_changed_files(
        [{"path": "new.py", "status": status, "previous_path": "old.py"}]
    )

    errors = list(
        contract_validator(_REPOSITORY_INCREMENTAL_SCHEMA).iter_errors(fixture)
    )

    assert errors, f"status {status!r} was accepted with a previous path"
