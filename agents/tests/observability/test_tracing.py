from collections.abc import Generator

import pytest

from sec_review_agents.observability.trace_context import (
    bind_trace_context,
    current_trace_context,
)
from sec_review_agents.observability.trace_context import (
    clear_trace_context as clear_bound_trace_context,
)
from sec_review_agents.observability.tracing import build_tracing_config


@pytest.fixture(autouse=True)
def clear_trace_context() -> Generator[None]:
    clear_bound_trace_context()
    yield
    clear_bound_trace_context()


def test_tracing_metadata_uses_agent_name(monkeypatch) -> None:
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)

    config = build_tracing_config(
        agent_name="issue-analyzer",
    )

    assert config.enabled is False
    assert config.metadata == {
        "sec_review_agent": "issue-analyzer",
    }


def test_tracing_metadata_uses_bound_trace_context(monkeypatch) -> None:
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)
    bind_trace_context(
        workflow="repository-review",
        run_id="run-1",
    )

    config = build_tracing_config(
        agent_name="repository-analyzer",
    )

    assert config.metadata == {
        "sec_review_agent": "repository-analyzer",
        "sec_review_workflow": "repository-review",
        "sec_review_run_id": "run-1",
        "langfuse_session_id": "run-1",
    }


def test_trace_context_ignores_none_and_strips_strings() -> None:
    bind_trace_context(
        run_id=None,
        workflow=" repository-review ",
    )

    assert current_trace_context() == {"workflow": "repository-review"}


def test_trace_context_rejects_blank_strings() -> None:
    with pytest.raises(ValueError, match="must not be blank"):
        bind_trace_context(workflow=" ")


def test_trace_context_rejects_non_strings() -> None:
    with pytest.raises(TypeError, match="must be str or None"):
        bind_trace_context(run_id=1)  # type: ignore[arg-type]
