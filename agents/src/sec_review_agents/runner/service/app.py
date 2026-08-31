import os
from hmac import compare_digest
from ipaddress import ip_address
from typing import Any

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from sec_review_agents.memory.store import initialize_configured_memory_store
from sec_review_agents.runner.core import (
    build_runner_error,
    is_supported_workflow,
    validate_run_id,
    validate_run_request_body,
)
from sec_review_agents.runner.input_preparation import INPUT_BUNDLE_ROOT_ENV
from sec_review_agents.runner.service.execution import RunnerExecutionBackend
from sec_review_agents.runner.service.temporal_execution import (
    TemporalRunnerExecutionBackend,
)
from sec_review_agents.utils.env import env_value

HOST_ENV = "RUNNER_SERVICE_HOST"


def _service_token() -> str | None:
    token = os.getenv("RUNNER_SERVICE_TOKEN")
    return token.strip() if token and token.strip() else None


def _is_loopback_host(host: str) -> bool:
    if host in {"localhost"}:
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _require_safe_auth_configuration() -> None:
    host = env_value(HOST_ENV) or "127.0.0.1"

    if _service_token() is not None:
        if env_value(INPUT_BUNDLE_ROOT_ENV) is None:
            raise RuntimeError(
                f"{INPUT_BUNDLE_ROOT_ENV} is required for runner service mode."
            )
        return

    if not _is_loopback_host(host):
        raise RuntimeError(
            f"RUNNER_SERVICE_TOKEN is required unless {HOST_ENV} is loopback."
        )


def _require_bearer_token(
    authorization: str | None = Header(default=None),
) -> None:
    token = _service_token()
    if token is None:
        return
    try:
        authorized = compare_digest(
            (authorization or "").encode("utf-8"),
            f"Bearer {token}".encode(),
        )
    except UnicodeError:
        authorized = False
    if not authorized:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid runner service token.",
        )


def _run_response(run: dict[str, Any]) -> dict[str, Any]:
    response = {
        "run_id": run.get("run_id"),
        "workflow": run.get("workflow"),
        "status": run["status"],
    }
    if run.get("result") is not None:
        response["result"] = run["result"]
    if run.get("error") is not None:
        response["error"] = run["error"]
    return response


def _runner_backend(request: Request) -> RunnerExecutionBackend:
    return request.app.state.runner_backend


def create_app(*, runner_backend: RunnerExecutionBackend | None = None) -> FastAPI:
    _require_safe_auth_configuration()
    initialize_configured_memory_store()
    app = FastAPI(title="sec-review-agents runner service")
    app.state.runner_backend = (
        runner_backend or TemporalRunnerExecutionBackend.from_env()
    )

    @app.get("/healthz", dependencies=[Depends(_require_bearer_token)])
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(
        "/v1/workflows/{workflow}/runs",
        dependencies=[Depends(_require_bearer_token)],
    )
    async def create_run(
        workflow: str,
        request: Any = Body(...),
        runner_backend: RunnerExecutionBackend = Depends(_runner_backend),
    ) -> JSONResponse:
        validation_error = validate_run_request_body(request)
        if validation_error:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": build_runner_error(
                        code="RUNNER_REQUEST_INVALID",
                        category="input",
                        message=validation_error,
                    )
                },
            )

        run_id = request["run_id"]
        if not is_supported_workflow(workflow):
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "run_id": run_id,
                    "workflow": workflow,
                    "error": build_runner_error(
                        code="RUNNER_WORKFLOW_UNSUPPORTED",
                        category="workflow",
                        message=f"Unsupported workflow: {workflow}",
                    ),
                },
            )

        run = await runner_backend.start(
            workflow=workflow,
            run_id=run_id,
            input_data=request["input"],
            runtime=request.get("runtime"),
        )
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content=_run_response(run),
        )

    @app.get("/v1/runs/{run_id}", dependencies=[Depends(_require_bearer_token)])
    async def get_run(
        run_id: str,
        runner_backend: RunnerExecutionBackend = Depends(_runner_backend),
    ) -> JSONResponse:
        try:
            validate_run_id(run_id)
        except ValueError as error:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "run_id": run_id,
                    "error": build_runner_error(
                        code="RUNNER_REQUEST_INVALID",
                        category="input",
                        message=str(error),
                    ),
                },
            )
        run = await runner_backend.get(run_id)
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Runner run not found.",
            )
        return JSONResponse(content=_run_response(run))

    return app


def main() -> None:
    import uvicorn

    host = os.getenv(HOST_ENV, "127.0.0.1")
    port = int(os.getenv("RUNNER_SERVICE_PORT", "8000"))
    uvicorn.run(create_app(), host=host, port=port)


__all__ = ["create_app", "main"]
