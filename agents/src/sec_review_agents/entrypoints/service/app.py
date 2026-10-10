"""Expose the review runner over HTTP and delegate runs to a workflow gateway."""

import os
from hmac import compare_digest
from ipaddress import ip_address
from typing import Any

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from sec_review_agents.artifacts.input_storage import ARTIFACT_S3_BUCKET_ENV
from sec_review_agents.entrypoints.contract_schema import validate_v5_workflow_input
from sec_review_agents.entrypoints.input_preparation import INPUT_BUNDLE_ROOT_ENV
from sec_review_agents.entrypoints.run_protocol import (
    RUNNER_REQUEST_INVALID,
    RUNNER_RUN_CONFLICT,
    RUNNER_RUN_NOT_FOUND,
    RUNNER_WORKFLOW_UNSUPPORTED,
    build_runner_error,
    is_supported_workflow,
    parse_status_query_body,
    validate_run_id,
    validate_run_request_body,
)
from sec_review_agents.entrypoints.service.gateway import (
    RunnerRunConflictError,
    RunnerWorkflowGateway,
)
from sec_review_agents.entrypoints.service.temporal_gateway import (
    TemporalRunnerWorkflowGateway,
)
from sec_review_agents.memory.store import initialize_configured_memory_store
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
        if (
            env_value(INPUT_BUNDLE_ROOT_ENV) is None
            and env_value(ARTIFACT_S3_BUCKET_ENV) is None
        ):
            raise RuntimeError(
                f"{INPUT_BUNDLE_ROOT_ENV} or {ARTIFACT_S3_BUCKET_ENV} is required "
                "for runner service mode."
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
    if run.get("artifact_storage") is not None:
        response["artifact_storage"] = run["artifact_storage"]
    return response


def _runner_gateway(request: Request) -> RunnerWorkflowGateway:
    return request.app.state.runner_gateway


def create_app(*, runner_gateway: RunnerWorkflowGateway | None = None) -> FastAPI:
    _require_safe_auth_configuration()
    initialize_configured_memory_store()
    app = FastAPI(title="sec-review-agents runner service")
    app.state.runner_gateway = (
        runner_gateway or TemporalRunnerWorkflowGateway.from_env()
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
        runner_gateway: RunnerWorkflowGateway = Depends(_runner_gateway),
    ) -> JSONResponse:
        validation_error = validate_run_request_body(request)
        if validation_error:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": build_runner_error(
                        code=RUNNER_REQUEST_INVALID,
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
                        code=RUNNER_WORKFLOW_UNSUPPORTED,
                        category="workflow",
                        message=f"Unsupported workflow: {workflow}",
                    ),
                },
            )

        try:
            validate_v5_workflow_input(request["input"], workflow)
        except ValueError as error:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "run_id": run_id,
                    "workflow": workflow,
                    "error": build_runner_error(
                        code=RUNNER_REQUEST_INVALID,
                        category="input",
                        message=str(error),
                    ),
                },
            )

        try:
            run = await runner_gateway.start(
                workflow=workflow,
                run_id=run_id,
                input_data=request["input"],
                runtime=request.get("runtime"),
            )
        except RunnerRunConflictError as error:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={
                    "run_id": error.run_id,
                    "workflow": error.requested_workflow,
                    "error": build_runner_error(
                        code=RUNNER_RUN_CONFLICT,
                        category="input",
                        message=str(error),
                        details={
                            "existing_workflow": error.existing_workflow,
                        },
                    ),
                },
            )
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content=_run_response(run),
        )

    @app.get("/v1/runs/{run_id}", dependencies=[Depends(_require_bearer_token)])
    async def get_run(
        run_id: str,
        runner_gateway: RunnerWorkflowGateway = Depends(_runner_gateway),
    ) -> JSONResponse:
        try:
            validate_run_id(run_id)
        except ValueError as error:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "run_id": run_id,
                    "error": build_runner_error(
                        code=RUNNER_REQUEST_INVALID,
                        category="input",
                        message=str(error),
                    ),
                },
            )
        run = await runner_gateway.get(run_id)
        if run is None:
            return JSONResponse(
                status_code=status.HTTP_404_NOT_FOUND,
                content={
                    "run_id": run_id,
                    "error": build_runner_error(
                        code=RUNNER_RUN_NOT_FOUND,
                        category="runtime",
                        message="Runner run not found.",
                    ),
                },
            )
        return JSONResponse(content=_run_response(run))

    # A status query answers "did anything change?" for the runs a caller already tracks,
    # which is the question a polling caller asks far more often than it needs results.
    # It therefore returns status tokens only: the full run record is fetched once per
    # terminal run through GET /v1/runs/{run_id}, and returning it here would move every
    # review result on every poll instead of once.
    @app.post("/v1/runs/status", dependencies=[Depends(_require_bearer_token)])
    async def get_run_statuses(
        request: Any = Body(...),
        runner_gateway: RunnerWorkflowGateway = Depends(_runner_gateway),
    ) -> JSONResponse:
        query = parse_status_query_body(request)
        if isinstance(query, str):
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": build_runner_error(
                        code=RUNNER_REQUEST_INVALID,
                        category="input",
                        message=query,
                    )
                },
            )

        async def read_statuses() -> tuple[dict[str, str], list[str]]:
            statuses: dict[str, str] = {}
            missing: list[str] = []
            for run_id in query.run_ids:
                run = await runner_gateway.get(run_id)
                if run is None:
                    missing.append(run_id)
                else:
                    statuses[run_id] = run["status"]
            return statuses, missing

        statuses, missing = await read_statuses()
        return JSONResponse(
            content={
                "runs": [
                    {"run_id": run_id, "status": run_status}
                    for run_id, run_status in statuses.items()
                ],
                # A run the Runner has no record for is reported separately rather than
                # dropped: the caller must be able to tell "never accepted" from "the
                # Runner skipped it", and it must not have to diff the response to find
                # out.
                "missing": missing,
            }
        )

    return app


def main() -> None:
    import uvicorn

    host = os.getenv(HOST_ENV, "127.0.0.1")
    port = int(os.getenv("RUNNER_SERVICE_PORT", "8000"))
    uvicorn.run(create_app(), host=host, port=port)


__all__ = ["create_app", "main"]
