"""Both schema interoperability and real HTTP decoding reject malformed messages."""

import json
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import pytest
from jsonschema.exceptions import ValidationError

from sec_review_agents.memory import catalog_schema
from sec_review_agents.memory.catalog_client import MemoryCatalogClient
from tests.contract_fixtures import (
    memory_catalog_fixture,
    memory_catalog_fixture_manifest,
    memory_catalog_fixture_names,
)

_MANIFEST = memory_catalog_fixture_manifest()
_CASES = [
    (name, schema, valid)
    for group, valid in (("schema_fixtures", True), ("invalid_schema_fixtures", False))
    for name, schema in _MANIFEST[group].items()
]


def test_shared_manifest_covers_every_schema_and_fixture() -> None:
    names = [name for name, _, _ in _CASES]
    assert len(names) == len(set(names))
    assert sorted(names) == memory_catalog_fixture_names()
    assert set(_MANIFEST["schema_fixtures"].values()) == set(
        catalog_schema._document()["components"]["schemas"]
    )

    assert set(_MANIFEST["invalid_schema_fixtures"].values()) == set(
        catalog_schema._document()["components"]["schemas"]
    )


@pytest.mark.parametrize("name,schema,valid", _CASES, ids=[case[0] for case in _CASES])
def test_shared_schema_cases(name: str, schema: str, valid: bool) -> None:
    validator = catalog_schema._validator(schema)
    value = memory_catalog_fixture(name)
    if valid:
        validator.validate(value)
    else:
        with pytest.raises(ValidationError):
            validator.validate(value)


class _Response(BytesIO):
    def __init__(self, value: object, status: int) -> None:
        super().__init__(json.dumps(value).encode())
        self.status = status


def _response_operations() -> list[tuple[str, str, int, str]]:
    operations = []
    for path, methods in catalog_schema._document()["paths"].items():
        for method, operation in methods.items():
            if not isinstance(operation, dict) or "operationId" not in operation:
                continue
            for status, response in operation["responses"].items():
                if not str(status).startswith("2"):
                    continue
                schema = response["content"]["application/json"]["schema"][
                    "$ref"
                ].split("/")[-1]
                operations.append((method.upper(), path, int(status), schema))
    return operations


@pytest.mark.parametrize("method,path,status,schema", _response_operations())
def test_every_success_operation_checks_shared_cases_at_http_exit(
    method: str, path: str, status: int, schema: str
) -> None:
    client = MemoryCatalogClient("http://catalog", "unused")
    cases = [case for case in _CASES if case[1] == schema]
    assert any(valid for _, _, valid in cases)
    assert any(not valid for _, _, valid in cases)
    for name, _, valid in cases:
        value = memory_catalog_fixture(name)
        with patch(
            "sec_review_agents.memory.catalog_client._open_catalog_request",
            return_value=_Response(value, status),
        ):
            if valid:
                assert client._request(method, path) == value
            else:
                with pytest.raises(RuntimeError, match="violates contract"):
                    client._request(method, path)


@pytest.mark.parametrize("status", [202, 204])
def test_undocumented_success_status_is_not_accepted(status: int) -> None:
    client = MemoryCatalogClient("http://catalog", "unused")
    with (
        patch(
            "sec_review_agents.memory.catalog_client._open_catalog_request",
            return_value=_Response({}, status),
        ),
        pytest.raises(RuntimeError, match="Undocumented"),
    ):
        client.get_memory_tree()


def test_configured_contract_root_is_authoritative(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SEC_REVIEW_CONTRACTS_ROOT", str(tmp_path))
    catalog_schema._document.cache_clear()
    try:
        with pytest.raises(RuntimeError, match="does not contain"):
            catalog_schema._document()
    finally:
        catalog_schema._document.cache_clear()


@pytest.mark.parametrize(
    "name,schema,valid", [case for case in _CASES if case[1] == "ErrorResponse"]
)
def test_http_errors_are_validated_before_error_classification(
    name: str, schema: str, valid: bool
) -> None:
    from email.message import Message
    from urllib.error import HTTPError

    from sec_review_agents.memory.catalog_client import MemoryCatalogConflictError

    client = MemoryCatalogClient("http://catalog", "unused")
    error = HTTPError(
        "http://catalog/v1/extractions",
        409,
        "Conflict",
        Message(),
        BytesIO(json.dumps(memory_catalog_fixture(name)).encode()),
    )
    with patch(
        "sec_review_agents.memory.catalog_client._open_catalog_request",
        side_effect=error,
    ):
        if valid:
            with pytest.raises(MemoryCatalogConflictError):
                client._request("POST", "/v1/extractions")
        else:
            with pytest.raises(RuntimeError, match="invalid HTTP 409") as raised:
                client._request("POST", "/v1/extractions")
            assert not isinstance(raised.value, MemoryCatalogConflictError)


def test_invalid_json_is_a_protocol_error() -> None:
    response = _Response({}, 200)
    response.seek(0)
    response.write(b"not JSON")
    response.seek(0)
    with (
        patch(
            "sec_review_agents.memory.catalog_client._open_catalog_request",
            return_value=response,
        ),
        pytest.raises(RuntimeError, match="invalid JSON"),
    ):
        MemoryCatalogClient("http://catalog", "unused").get_memory_tree()
