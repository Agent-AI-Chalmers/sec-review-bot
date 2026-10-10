"""Expose the review runner over HTTP and delegate runs to a workflow gateway."""

import os
from hmac import compare_digest
from ipaddress import ip_address
from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Path, Request, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import WithJsonSchema

from sec_review_agents.artifacts.input_storage import ARTIFACT_S3_BUCKET_ENV
from sec_review_agents.entrypoints.contract_schema import validate_v5_workflow_input
from sec_review_agents.entrypoints.input_preparation import INPUT_BUNDLE_ROOT_ENV
from sec_review_agents.entrypoints.run_protocol import (
    RUN_ID_PATTERN,
    RUNNER_REQUEST_INVALID,
    RUNNER_RUN_CONFLICT,
    RUNNER_RUN_NOT_FOUND,
    RUNNER_WORKFLOW_UNSUPPORTED,
    SUPPORTED_RUNNER_WORKFLOWS,
    build_runner_error,
    is_supported_workflow,
)
from sec_review_agents.entrypoints.service.api_models import (
    CreateRunRequest,
    HealthResponse,
    RunnerErrorResponse,
    RunResponse,
    RunStatusQuery,
    RunStatusResponse,
    RunStatusToken,
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

# Declared so the published contract carries the credential it expects. `auto_error=False`
# keeps the rejection in this module, where a missing or wrong token is a 401 rather than
# the 403 the scheme would raise on its own.
_bearer_scheme = HTTPBearer(
    auto_error=False,
    description="Bearer token configured through RUNNER_SERVICE_TOKEN.",
)

# Which workflows exist is owned by the v5 input schemas, one per workflow. The path
# parameter stays a string because an unknown workflow is a semantic failure with its own
# error code, not a malformed request; this only publishes the set the runner accepts.
_WorkflowPath = Annotated[
    str,
    Path(),
    WithJsonSchema({"type": "string", "enum": sorted(SUPPORTED_RUNNER_WORKFLOWS)}),
]


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
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)
    ] = None,
) -> None:
    token = _service_token()
    if token is None:
        return
    # Compared as bytes: a configured token outside ASCII must fail closed rather than
    # raise out of the credential comparison.
    try:
        authorized = compare_digest(
            (credentials.credentials if credentials else "").encode("utf-8"),
            token.encode("utf-8"),
        )
    except UnicodeError:
        authorized = False
    if not authorized:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid runner service token.",
        )


def _run_response(run: dict[str, Any]) -> RunResponse:
    # The route serializes with `exclude_none`, so fields the gateway has not produced yet
    # are omitted rather than sent as null — the shape callers already receive.
    return RunResponse(
        run_id=run.get("run_id"),
        workflow=run.get("workflow"),
        status=run["status"],
        result=run.get("result"),
        error=run.get("error"),
        artifact_storage=run.get("artifact_storage"),
    )


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
    def healthz() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.post(
        "/v1/workflows/{workflow}/runs",
        dependencies=[Depends(_require_bearer_token)],
        status_code=status.HTTP_202_ACCEPTED,
        response_model=RunResponse,
        response_model_exclude_none=True,
        responses={
            status.HTTP_400_BAD_REQUEST: {"model": RunnerErrorResponse},
            status.HTTP_409_CONFLICT: {"model": RunnerErrorResponse},
        },
    )
    async def create_run(
        workflow: _WorkflowPath,
        request: CreateRunRequest,
        runner_gateway: RunnerWorkflowGateway = Depends(_runner_gateway),
    ) -> RunResponse | JSONResponse:
        # The body shape is FastAPI's to reject now, with 422 and its own error body. The
        # checks below are semantic: a well-formed request for work this runner cannot do.
        run_id = request.run_id
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
            validate_v5_workflow_input(request.input, workflow)
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
                input_data=request.input,
                runtime=request.runtime,
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
        return _run_response(run)

    @app.get(
        "/v1/runs/{run_id}",
        dependencies=[Depends(_require_bearer_token)],
        response_model=RunResponse,
        response_model_exclude_none=True,
        responses={status.HTTP_404_NOT_FOUND: {"model": RunnerErrorResponse}},
    )
    async def get_run(
        # The path parameter carries the run ID rule, so a malformed one is rejected before
        # this handler runs rather than inside it.
        run_id: Annotated[str, Path(pattern=RUN_ID_PATTERN.pattern)],
        runner_gateway: RunnerWorkflowGateway = Depends(_runner_gateway),
    ) -> RunResponse | JSONResponse:
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
        return _run_response(run)

    # A status query answers "did anything change?" for the runs a caller already tracks,
    # which is the question a polling caller asks far more often than it needs results.
    # It therefore returns status tokens only: the full run record is fetched once per
    # terminal run through GET /v1/runs/{run_id}, and returning it here would move every
    # review result on every poll instead of once.
    @app.post(
        "/v1/runs/status",
        dependencies=[Depends(_require_bearer_token)],
        response_model=RunStatusResponse,
        responses={status.HTTP_400_BAD_REQUEST: {"model": RunnerErrorResponse}},
    )
    async def get_run_statuses(
        request: RunStatusQuery,
        runner_gateway: RunnerWorkflowGateway = Depends(_runner_gateway),
    ) -> RunStatusResponse:
        # A repeated ID would make the caller read the response positionally for no gain,
        # and deduplicating here keeps the first-seen order the caller asked in.
        run_ids = list(dict.fromkeys(request.run_ids))

        async def read_statuses() -> tuple[dict[str, str], list[str]]:
            statuses: dict[str, str] = {}
            missing: list[str] = []
            for run_id in run_ids:
                run = await runner_gateway.get(run_id)
                if run is None:
                    missing.append(run_id)
                else:
                    statuses[run_id] = run["status"]
            return statuses, missing

        statuses, missing = await read_statuses()
        return RunStatusResponse(
            runs=[
                RunStatusToken(run_id=run_id, status=run_status)
                for run_id, run_status in statuses.items()
            ],
            # A run the Runner has no record for is reported separately rather than
            # dropped: the caller must be able to tell "never accepted" from "the Runner
            # skipped it", and it must not have to diff the response to find out.
            missing=missing,
        )

    return app


def main() -> None:
    import uvicorn

    host = os.getenv(HOST_ENV, "127.0.0.1")
    port = int(os.getenv("RUNNER_SERVICE_PORT", "8000"))
    uvicorn.run(create_app(), host=host, port=port)


__all__ = ["create_app", "main"]
