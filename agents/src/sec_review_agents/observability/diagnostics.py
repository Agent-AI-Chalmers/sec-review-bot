import time
from collections.abc import Sequence
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.observability.log_config import logger
from sec_review_agents.observability.trace_context import (
    bind_trace_context,
    clear_trace_context,
)
from sec_review_agents.utils.serialization import json_safe


def log_diagnostic(event: str, /, **fields: Any) -> None:
    safe_fields = {k: json_safe(v) for k, v in fields.items() if v is not None}
    logger.info(event, **safe_fields)


def bind_workflow_context(
    *,
    workflow: str,
    run_id: str | None = None,
) -> None:
    clear_trace_context()
    bind_trace_context(
        run_id=run_id,
        workflow=workflow,
    )


def log_stage_started(*, stage: str, **fields: Any) -> float:
    logger.info("stage_started", stage=stage, **fields)
    return time.perf_counter()


def log_stage_completed(*, stage: str, started_at: float, **fields: Any) -> None:
    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    logger.info("stage_completed", stage=stage, duration_ms=duration_ms, **fields)


def log_stage_failed(
    *, stage: str, started_at: float, error: Exception, **fields: Any
) -> None:
    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    logger.error(
        "stage_failed",
        stage=stage,
        duration_ms=duration_ms,
        error_type=error.__class__.__name__,
        error_message=str(error),
        retryable=False,
        exc_info=error,
        **fields,
    )


def log_case_processing(
    *, case_id: str | None, ordinal: int | None, total: int | None
) -> None:
    logger.debug("case_processing", case_id=case_id, ordinal=ordinal, total=total)


def log_agent_configuration(
    *,
    agent_name: str,
    agent: CompiledStateGraph,
    backend: BackendProtocol | None,
    middleware: Sequence[AgentMiddleware[Any, Any, Any]],
    recursion_limit: int | None,
    tracing_configured: bool,
) -> None:
    logger.debug(
        "agent_configuration",
        agent_name=agent_name,
        backend_type=type(backend).__name__,
        middleware=[type(item).__name__ for item in middleware],
        node_count=len(getattr(agent, "nodes", {}) or {}),
        recursion_limit=recursion_limit,
        tracing_configured=tracing_configured,
    )


def log_agent_invocation_started(
    *,
    agent_name: str,
    recursion_limit: int | None,
    tracing_enabled: bool,
) -> float:
    logger.info(
        "agent_invoke_started",
        agent_name=agent_name,
        recursion_limit=recursion_limit,
        tracing_enabled=tracing_enabled,
    )
    return time.perf_counter()


def log_agent_invocation_succeeded(
    *,
    agent_name: str,
    started_at: float,
    structured_response: Any,
) -> None:
    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    logger.info(
        "agent_invoke_succeeded",
        agent_name=agent_name,
        duration_ms=duration_ms,
        structured_response_type=(
            type(structured_response).__name__
            if structured_response is not None
            else None
        ),
    )


def log_agent_invocation_failed(
    *,
    agent_name: str,
    started_at: float,
    error: Exception,
) -> None:
    duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    logger.error(
        "agent_invoke_failed",
        agent_name=agent_name,
        duration_ms=duration_ms,
        error_type=error.__class__.__name__,
        error_message=str(error),
        retryable=False,
        exc_info=error,
    )
