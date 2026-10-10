"""Keep the published OpenAPI document identical to the service's own schema.

`contracts/integration-contract/openapi.json` is what the TypeScript side generates its
client types from, so it is a contract artifact rather than a build output. If it were
allowed to lag the service, those generated types would describe an API the runner no
longer serves — exactly the drift this family exists to prevent.
"""

import json

import pytest

from sec_review_agents.entrypoints.service.app import create_app
from tests.contract_fixtures import CONTRACT_ROOT

OPENAPI_PATH = CONTRACT_ROOT / "openapi.json"


@pytest.fixture(autouse=True)
def _loopback_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("RUNNER_SERVICE_HOST", "127.0.0.1")


def serialize(spec: dict[str, object]) -> str:
    return json.dumps(spec, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def test_committed_openapi_matches_the_service() -> None:
    expected = serialize(create_app().openapi())
    committed = OPENAPI_PATH.read_text(encoding="utf-8")

    assert committed == expected, (
        f"{OPENAPI_PATH} does not match the service's schema. "
        "Regenerate it with:\n"
        '  python -c "import json; from sec_review_agents.entrypoints.service.app '
        "import create_app; print(json.dumps(create_app().openapi(), indent=2, "
        'ensure_ascii=False, sort_keys=True))" > '
        f"{OPENAPI_PATH}"
    )


def test_committed_openapi_describes_every_route() -> None:
    """A document that lost its request bodies would still parse, so assert it has them."""
    spec = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))

    operations = [
        (method.upper(), path)
        for path, methods in spec["paths"].items()
        for method in methods
    ]
    assert ("POST", "/v1/workflows/{workflow}/runs") in operations
    assert ("POST", "/v1/runs/status") in operations
    assert ("GET", "/v1/runs/{run_id}") in operations

    status_request = spec["paths"]["/v1/runs/status"]["post"]["requestBody"]
    schema_ref = status_request["content"]["application/json"]["schema"]["$ref"]
    assert schema_ref.endswith("/RunStatusQuery")

    assert "HTTPBearer" in spec["components"]["securitySchemes"]
