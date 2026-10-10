"""Declare the runner service's HTTP shapes so FastAPI can publish them as OpenAPI.

These models exist for the contract, not for convenience. Before them every route took
`request: Any` and returned `JSONResponse`, so `/openapi.json` listed paths and nothing
else: the request and response shapes lived only in prose and in hand-written client code.
FastAPI derives the schema from these models, so the published contract cannot drift from
what the service accepts and returns.

Validation behaviour deliberately follows FastAPI's defaults. A body that does not match
its model is rejected with `422` and FastAPI's own error body, not the envelope the
handlers build for semantic failures. Shape errors therefore carry no `code`; callers see
them as non-retryable client errors, which is what they are.
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from sec_review_agents.entrypoints.run_protocol import (
    MAX_STATUS_QUERY_RUN_IDS,
    RUN_ID_PATTERN,
)

RunnerRunStatus = Literal["queued", "running", "succeeded", "failed"]
RunnerErrorCategory = Literal["input", "workflow", "llm", "runtime", "internal"]

# The run ID rule appears in three request and response shapes. Binding it once keeps the
# published schema and the checks in `run_protocol` from describing different IDs.
RunId = Annotated[
    str, Field(min_length=1, max_length=128, pattern=RUN_ID_PATTERN.pattern)
]


class RunnerError(BaseModel):
    """The envelope every runner error carries."""

    category: RunnerErrorCategory
    code: str = Field(description="Stable machine-readable error code.")
    message: str
    retryable: bool
    details: dict[str, Any] = Field(default_factory=dict)


class RunnerErrorResponse(BaseModel):
    """An error body.

    `run_id` and `workflow` are present when the runner already knows which run the request
    concerned, so a caller can attribute a failure without echoing its own request back.
    """

    error: RunnerError
    run_id: str | None = None
    workflow: str | None = None


class RunnerArtifactRef(BaseModel):
    """A stored diagnostic bundle, as `store_run_artifacts` reports it."""

    kind: Literal["diagnostic_bundle"]
    uri: str
    media_type: str
    digest: str
    size_bytes: int


class RunnerArtifactStorage(BaseModel):
    """Where a terminal run's diagnostics went, or why they are not there.

    The runner only attaches this once a run reaches a terminal state, and reports a failed
    upload as a status rather than an error, because storage is diagnostic metadata and not
    the business result.
    """

    status: Literal["available", "unavailable", "failed"]
    artifact: RunnerArtifactRef | None = None
    error_code: str | None = None
    message: str | None = None


class CreateRunRequest(BaseModel):
    """A request to start one workflow run."""

    run_id: RunId
    input: dict[str, Any]
    runtime: dict[str, Any] | None = None


class RunResponse(BaseModel):
    """One run as the runner reports it.

    `result`, `error`, and `artifact_storage` are omitted rather than null until they exist,
    which is why the route serializes with `exclude_none`.
    """

    run_id: str | None = None
    workflow: str | None = None
    status: RunnerRunStatus
    result: Any = None
    error: dict[str, Any] | None = None
    artifact_storage: RunnerArtifactStorage | None = None


class RunStatusQuery(BaseModel):
    """Which runs a status query wants status tokens for."""

    run_ids: list[RunId] = Field(min_length=1, max_length=MAX_STATUS_QUERY_RUN_IDS)


class RunStatusToken(BaseModel):
    """One run's status, without its record.

    A polling caller asks whether anything changed far more often than it needs results, so
    this carries no result: the full record is fetched once per terminal run.
    """

    run_id: RunId
    status: str


class RunStatusResponse(BaseModel):
    runs: list[RunStatusToken]
    missing: list[str] = Field(
        description="Requested run IDs the runner holds no record for."
    )


class HealthResponse(BaseModel):
    status: Literal["ok"]


__all__ = [
    "CreateRunRequest",
    "HealthResponse",
    "RunId",
    "RunResponse",
    "RunStatusQuery",
    "RunStatusResponse",
    "RunStatusToken",
    "RunnerArtifactRef",
    "RunnerArtifactStorage",
    "RunnerError",
    "RunnerErrorCategory",
    "RunnerErrorResponse",
    "RunnerRunStatus",
]
