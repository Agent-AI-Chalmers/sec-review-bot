from typing import Any

from fastapi.testclient import TestClient

from sec_review_agents.entrypoints.service import app as service_app
from sec_review_agents.entrypoints.service.gateway import RunnerRunConflictError
from tests.contract_fixtures import contract_fixture


class FakeRunnerWorkflowGateway:
    def __init__(self, *, start_error: Exception | None = None) -> None:
        self.runs: dict[str, dict[str, Any]] = {}
        self.start_error = start_error

    async def start(
        self,
        *,
        workflow: str,
        run_id: str,
        input_data: dict[str, Any],
        runtime: Any = None,
    ) -> dict[str, Any]:
        if self.start_error is not None:
            raise self.start_error
        run = {
            "run_id": run_id,
            "workflow": workflow,
            "status": "running",
            "input": input_data,
            "runtime": runtime,
        }
        self.runs[run_id] = run
        return run

    async def get(self, run_id: str) -> dict[str, Any] | None:
        run = self.runs.get(run_id)
        return dict(run) if run is not None else None


def _request() -> dict[str, Any]:
    return {
        "run_id": "run-service",
        "input": contract_fixture("v4", "issue-review-input.json"),
    }


def _use_loopback_host(monkeypatch) -> None:
    monkeypatch.setenv("RUNNER_SERVICE_HOST", "127.0.0.1")


def test_healthz(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    client = TestClient(
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway())
    )

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_create_app_initializes_configured_memory_dir(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    memory_dir = tmp_path / "memory"
    monkeypatch.setenv("AGENT_MEMORY_DIR", str(memory_dir))

    TestClient(service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway()))

    assert (memory_dir / "memory" / "MEMORY.md").is_file()
    assert (memory_dir / "memory" / "topics").is_dir()
    assert (memory_dir / "observations").is_dir()
    assert (memory_dir / "memory_state.sqlite").is_file()


def test_create_run_rejects_invalid_request(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    client = TestClient(
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway())
    )

    response = client.post("/v1/workflows/issue-review/runs", json={})

    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "RUNNER_REQUEST_INVALID"


def test_create_run_rejects_invalid_run_id_before_start(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    gateway = FakeRunnerWorkflowGateway()
    client = TestClient(service_app.create_app(runner_gateway=gateway))

    response = client.post(
        "/v1/workflows/issue-review/runs",
        json={
            "run_id": "../run-service",
            "input": contract_fixture("v4", "issue-review-input.json"),
        },
    )

    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "RUNNER_REQUEST_INVALID"
    assert "run_id must match" in body["error"]["message"]
    assert gateway.runs == {}


def test_create_run_rejects_schema_invalid_input_before_start(monkeypatch) -> None:
    """The public HTTP boundary must enforce the same v4 shape as contract clients."""
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    gateway = FakeRunnerWorkflowGateway()
    client = TestClient(service_app.create_app(runner_gateway=gateway))

    response = client.post(
        "/v1/workflows/repository-review/runs",
        json={
            "run_id": "run-service",
            "input": contract_fixture(
                "v4", "invalid-repository-review-input-zero-max-file-bytes.json"
            ),
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "RUNNER_REQUEST_INVALID"
    assert gateway.runs == {}


def test_create_run_rejects_unsupported_workflow_before_start(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    gateway = FakeRunnerWorkflowGateway()
    client = TestClient(service_app.create_app(runner_gateway=gateway))

    response = client.post("/v1/workflows/not-real/runs", json=_request())

    assert response.status_code == 400
    body = response.json()
    assert body["workflow"] == "not-real"
    assert body["error"]["category"] == "workflow"
    assert body["error"]["code"] == "RUNNER_WORKFLOW_UNSUPPORTED"
    assert gateway.runs == {}


def test_create_run_starts_temporal_workflow(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    gateway = FakeRunnerWorkflowGateway()
    client = TestClient(service_app.create_app(runner_gateway=gateway))

    created = client.post("/v1/workflows/issue-review/runs", json=_request())

    assert created.status_code == 202
    created_body = created.json()
    assert created_body["run_id"] == "run-service"
    assert created_body["workflow"] == "issue-review"
    assert created_body["status"] == "running"

    fetched = client.get(f"/v1/runs/{created_body['run_id']}")

    assert fetched.status_code == 200
    fetched_body = fetched.json()
    assert fetched_body["status"] == "running"


def test_create_run_returns_conflict_for_reused_run_id_with_different_request(
    monkeypatch,
) -> None:
    """A reused run ID must expose request mismatch as a non-retryable conflict."""
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    client = TestClient(
        service_app.create_app(
            runner_gateway=FakeRunnerWorkflowGateway(
                start_error=RunnerRunConflictError(
                    "run-service",
                    requested_workflow="issue-review",
                    existing_workflow="pull-request-review",
                )
            )
        )
    )

    response = client.post("/v1/workflows/issue-review/runs", json=_request())

    assert response.status_code == 409
    assert response.json() == {
        "run_id": "run-service",
        "workflow": "issue-review",
        "error": {
            "category": "input",
            "code": "RUNNER_RUN_CONFLICT",
            "message": (
                "Runner run_id run-service is already bound to another request."
            ),
            "retryable": False,
            "details": {"existing_workflow": "pull-request-review"},
        },
    }


def test_get_run_returns_worker_result(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    gateway = FakeRunnerWorkflowGateway()
    gateway.runs["run-service"] = {
        "run_id": "run-service",
        "workflow": "issue-review",
        "status": "succeeded",
        "result": {"contract_version": "v4"},
    }
    client = TestClient(service_app.create_app(runner_gateway=gateway))

    fetched = client.get("/v1/runs/run-service")

    assert fetched.status_code == 200
    fetched_body = fetched.json()
    assert fetched_body["status"] == "succeeded"
    assert fetched_body["result"] == {"contract_version": "v4"}


def test_get_run_returns_structured_not_found_error(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    client = TestClient(
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway())
    )

    fetched = client.get("/v1/runs/run-missing")

    assert fetched.status_code == 404
    assert fetched.json() == {
        "run_id": "run-missing",
        "error": {
            "category": "runtime",
            "code": "RUNNER_RUN_NOT_FOUND",
            "message": "Runner run not found.",
            "retryable": False,
            "details": {},
        },
    }


def test_get_run_rejects_invalid_run_id_before_backend_lookup(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    _use_loopback_host(monkeypatch)
    gateway = FakeRunnerWorkflowGateway()
    gateway.runs["run service"] = {
        "run_id": "run service",
        "workflow": "issue-review",
        "status": "succeeded",
    }
    client = TestClient(service_app.create_app(runner_gateway=gateway))

    fetched = client.get("/v1/runs/run%20service")

    assert fetched.status_code == 400
    body = fetched.json()
    assert body["run_id"] == "run service"
    assert body["error"]["code"] == "RUNNER_REQUEST_INVALID"
    assert "run_id must match" in body["error"]["message"]


def test_bearer_token_is_required_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("RUNNER_SERVICE_TOKEN", "secret")
    monkeypatch.setenv("SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT", "/tmp/runner-inputs")
    client = TestClient(
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway())
    )

    assert client.get("/healthz").status_code == 401
    response = client.get("/healthz", headers={"Authorization": "Bearer secret"})
    assert response.status_code == 200


def test_bearer_token_rejects_near_match(monkeypatch) -> None:
    monkeypatch.setenv("RUNNER_SERVICE_TOKEN", "secret")
    monkeypatch.setenv("SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT", "/tmp/runner-inputs")
    client = TestClient(
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway())
    )

    response = client.get("/healthz", headers={"Authorization": "Bearer secretx"})

    assert response.status_code == 401


def test_bearer_token_rejects_non_ascii_configured_token_without_error(
    monkeypatch,
) -> None:
    monkeypatch.setenv("RUNNER_SERVICE_TOKEN", "secrét")
    monkeypatch.setenv("SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT", "/tmp/runner-inputs")
    client = TestClient(
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway()),
        raise_server_exceptions=False,
    )

    response = client.get("/healthz", headers={"Authorization": "Bearer secret"})

    assert response.status_code == 401


def test_create_app_requires_input_bundle_root_with_token(monkeypatch) -> None:
    monkeypatch.setenv("RUNNER_SERVICE_TOKEN", "secret")
    monkeypatch.delenv("SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT", raising=False)
    monkeypatch.setenv("RUNNER_SERVICE_HOST", "127.0.0.1")

    try:
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway())
    except RuntimeError as error:
        assert "SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT is required" in str(error)
    else:
        raise AssertionError("create_app accepted token mode without input bundle root")


def test_create_app_requires_token_unless_host_is_loopback(monkeypatch) -> None:
    monkeypatch.delenv("RUNNER_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("RUNNER_SERVICE_HOST", "0.0.0.0")

    try:
        service_app.create_app(runner_gateway=FakeRunnerWorkflowGateway())
    except RuntimeError as error:
        assert "RUNNER_SERVICE_TOKEN is required" in str(error)
    else:
        raise AssertionError("create_app accepted unauthenticated non-loopback service")
