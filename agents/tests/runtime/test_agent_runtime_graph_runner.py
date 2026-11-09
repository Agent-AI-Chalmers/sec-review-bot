from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch, sentinel

import pytest
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.callbacks.manager import CallbackManager
from pydantic import BaseModel

from sec_review_agents.observability.tracing import TracingConfig
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.trajectories import read_trajectory_messages


class ProbeOutput(BaseModel):
    status: str


def _stream(*updates: dict[str, Any], error: Exception | None = None):
    async def astream(*args: Any, **kwargs: Any):
        _ = args, kwargs
        for update in updates:
            yield {
                "event": "on_chain_stream",
                "parent_ids": [],
                "data": {"chunk": update},
            }
        if error is not None:
            raise error

    return astream


def _successful_agent(*, messages: list[Any] | None = None) -> Mock:
    agent = Mock()
    agent.astream_events = Mock(
        side_effect=_stream(
            {
                "model": {
                    "messages": messages or [],
                    "structured_response": ProbeOutput(status="ok"),
                }
            }
        )
    )
    return agent


@pytest.mark.asyncio
async def test_invoke_returns_structured_response_after_success(
    tmp_path: Path,
) -> None:
    agent = _successful_agent()
    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=3,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed"
        ),
    ):
        trajectory_path = tmp_path / "trajectory.jsonl"
        result = await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
            config={"metadata": {"scope": "unit"}},
            trajectory_paths=(trajectory_path,),
        )
        trajectory_messages = read_trajectory_messages(trajectory_path)

    assert result == ProbeOutput(status="ok")
    invoke_config = agent.astream_events.call_args.kwargs["config"]
    assert invoke_config["metadata"] == {
        "scope": "unit",
        "sec_review_agent": "test-agent",
    }
    assert invoke_config["recursion_limit"] == 3
    assert [item["role"] for item in trajectory_messages] == ["user"]
    assert trajectory_messages[0]["role"] == "user"


@pytest.mark.asyncio
async def test_trajectory_callback_does_not_mark_langfuse_tracing_enabled(
    tmp_path: Path,
) -> None:
    agent = _successful_agent()
    tracing_config = TracingConfig(
        enabled=False,
        callback=None,
        metadata={"sec_review_agent": "test-agent"},
        run_name="test-agent",
    )

    trajectory_path = tmp_path / "trajectory.jsonl"
    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.build_tracing_config",
            return_value=tracing_config,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ) as started_mock,
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed"
        ),
    ):
        await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
            trajectory_paths=(trajectory_path,),
        )
        trajectory_messages = read_trajectory_messages(trajectory_path)

    started_mock.assert_called_once()
    assert not started_mock.call_args.kwargs["tracing_enabled"]
    assert "callbacks" not in agent.astream_events.call_args.kwargs["config"]
    assert trajectory_messages[0]["role"] == "user"


@pytest.mark.asyncio
async def test_trajectory_export_preserves_callback_manager(
    tmp_path: Path,
) -> None:
    """Preserve caller callbacks independently of ambient tracing configuration."""
    agent = _successful_agent()
    caller_handler = BaseCallbackHandler()
    callback_manager = CallbackManager([caller_handler])
    tracing_config = TracingConfig(
        enabled=False,
        callback=None,
        metadata={"sec_review_agent": "test-agent"},
        run_name="test-agent",
    )

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.build_tracing_config",
            return_value=tracing_config,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed"
        ),
    ):
        await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
            config={"callbacks": callback_manager},
            trajectory_paths=(tmp_path / "trajectory.jsonl",),
        )

    invoke_callbacks = agent.astream_events.call_args.kwargs["config"]["callbacks"]
    assert isinstance(invoke_callbacks, CallbackManager)
    assert caller_handler in invoke_callbacks.handlers
    assert invoke_callbacks.handlers == [caller_handler]


@pytest.mark.asyncio
async def test_invoke_uses_async_agent_stream() -> None:
    astream_calls: list[dict] = []

    async def astream(payload, *, config=None, stream_mode=None, version=None):
        astream_calls.append(
            {
                "payload": payload,
                "config": config,
                "stream_mode": stream_mode,
            }
        )
        yield {
            "event": "on_chain_stream",
            "parent_ids": [],
            "data": {
                "chunk": {"model": {"structured_response": ProbeOutput(status="ok")}}
            },
        }

    agent = Mock()
    agent.astream_events = astream

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed"
        ),
    ):
        result = await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
        )

    assert result == ProbeOutput(status="ok")
    assert len(astream_calls) == 1
    assert astream_calls[0]["payload"]["messages"][0].content == "prompt"
    assert astream_calls[0]["stream_mode"] == "updates"


@pytest.mark.asyncio
async def test_invoke_uses_async_agent_without_sync_wrapper() -> None:
    agent = _successful_agent()

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed"
        ),
    ):
        result = await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
        )

    assert result == ProbeOutput(status="ok")
    agent.astream_events.assert_called_once()


@pytest.mark.asyncio
async def test_invoke_logs_failure_and_reraises() -> None:
    agent = Mock()
    agent.astream_events = Mock(side_effect=_stream(error=RuntimeError("boom")))

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=3,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed",
        ) as failed_mock,
        pytest.raises(RuntimeError, match="boom"),
    ):
        await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
        )

    failed_mock.assert_called_once()


@pytest.mark.asyncio
async def test_stream_failure_preserves_completed_message_updates(
    tmp_path: Path,
) -> None:
    agent = Mock()
    agent.astream_events = Mock(
        side_effect=_stream(
            {
                "model": {
                    "messages": [
                        {
                            "id": "partial-ai",
                            "role": "assistant",
                            "content": "Evidence collected before failure.",
                        }
                    ]
                }
            },
            error=RuntimeError("boom"),
        )
    )
    trajectory_path = tmp_path / "trajectory.jsonl"

    with pytest.raises(RuntimeError, match="boom"):
        await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
            trajectory_paths=(trajectory_path,),
        )

    messages = read_trajectory_messages(trajectory_path)
    assert [message["content"] for message in messages] == [
        "prompt",
        "Evidence collected before failure.",
    ]


@pytest.mark.asyncio
async def test_missing_structured_response_raises() -> None:
    agent = Mock()
    agent.astream_events = Mock(
        side_effect=_stream(
            {"model": {"messages": [{"role": "assistant", "content": "prose"}]}}
        )
    )

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=3,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed",
        ) as failed_mock,
        pytest.raises(RuntimeError, match="without structured_response"),
    ):
        await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
        )

    assert agent.astream_events.call_count == 1
    failed_mock.assert_called_once()


@pytest.mark.asyncio
async def test_trajectory_messages_cover_message_dump_fields(
    tmp_path: Path,
) -> None:
    class FakeMessage:
        type = "ai"
        id = "msg-1"
        name = "assistant"
        content = "hello"

        def __init__(self) -> None:
            self.additional_kwargs = {"k": "v"}
            self.response_metadata = {"finish_reason": "stop"}
            self.tool_calls = [{"name": "tool"}]
            self.invalid_tool_calls: list[dict[str, Any]] = []
            self.tool_call_chunks: list[dict[str, Any]] = []
            self.usage_metadata = {"input_tokens": 1, "output_tokens": 2}

    agent = _successful_agent(messages=[FakeMessage()])

    trajectory_path = tmp_path / "trajectory.jsonl"
    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started",
            return_value=sentinel.started_at,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_succeeded"
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_failed"
        ),
    ):
        await invoke_agent_runtime_graph(
            response_format=ProbeOutput,
            agent=agent,
            agent_name="test-agent",
            user_prompt="prompt",
            trajectory_paths=(trajectory_path,),
        )
        messages = read_trajectory_messages(trajectory_path)

    ai_messages = [item for item in messages if item["role"] == "assistant"]
    assert len(ai_messages) == 1
    message = ai_messages[0]
    assert set(message) == {
        "role",
        "id",
        "name",
        "content",
        "additional_kwargs",
        "response_metadata",
        "tool_calls",
        "invalid_tool_calls",
        "tool_call_chunks",
        "usage_metadata",
    }
    assert message["content"] == "hello"


@pytest.mark.asyncio
async def test_model_response_is_preserved_without_serialization() -> None:
    """Discovery must keep the validated model rather than dump and reconstruct it."""
    from sec_review_agents.agents.discovery.model import DiscoveryOutput

    output = DiscoveryOutput.model_validate(
        {
            "candidates": [
                {
                    "category": "injection",
                    "description": "Untrusted query",
                    "locations": [{"file": "app.py", "label": "query", "line": 2}],
                    "evidence": ["execute(query)"],
                }
            ]
        }
    )
    agent = _successful_agent()
    agent.astream_events = Mock(
        side_effect=_stream({"model": {"structured_response": output}})
    )
    result = await invoke_agent_runtime_graph(
        agent=agent,
        response_format=DiscoveryOutput,
        agent_name="model-probe",
        user_prompt="probe",
    )
    assert result is output
    assert result.candidates[0].locations[0].line == 2


@pytest.mark.asyncio
async def test_model_consumer_rejects_unvalidated_dictionary() -> None:
    from sec_review_agents.agents.discovery.model import DiscoveryOutput

    agent = _successful_agent()
    agent.astream_events = Mock(
        side_effect=_stream({"model": {"structured_response": {"candidates": []}}})
    )
    with pytest.raises(TypeError, match="Expected DiscoveryOutput"):
        await invoke_agent_runtime_graph(
            agent=agent,
            response_format=DiscoveryOutput,
            agent_name="model-probe",
            user_prompt="probe",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("target", [30, 101])
@pytest.mark.parametrize(
    ("explicit", "max_steps", "caller_limit", "expected"),
    [
        (None, None, None, None),
        (None, None, 25, 25),
        (None, "20", 25, 48),
        ("40", "20", 25, 40),
    ],
)
async def test_real_graph_event_stream_preserves_recursion_budget(
    monkeypatch, explicit, max_steps, caller_limit, expected, target
):
    """Event streaming must not inject Core's 25-step default into LangGraph."""
    from typing import TypedDict

    from langgraph.errors import GraphRecursionError
    from langgraph.graph import END, START, StateGraph

    class State(TypedDict, total=False):
        count: int
        structured_response: ProbeOutput

    def step(state: State) -> State:
        count = state.get("count", 0) + 1
        return {"count": count, "structured_response": ProbeOutput(status="ok")}

    graph = StateGraph(State)
    graph.add_node("step", step)
    graph.add_edge(START, "step")
    graph.add_conditional_edges(
        "step", lambda state: END if state["count"] >= target else "step"
    )
    agent = graph.compile()
    for key, value in {
        "AGENT_GRAPH_RECURSION_LIMIT": explicit,
        "AGENT_GRAPH_MAX_STEPS": max_steps,
        "AGENT_GRAPH_RECURSION_BUFFER": "8",
    }.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    config = {} if caller_limit is None else {"recursion_limit": caller_limit}
    with patch(
        "sec_review_agents.runtime.agent_runtime_graph.log_agent_invocation_started"
    ) as started:
        kwargs: dict[str, Any] = {
            "agent": agent,
            "response_format": ProbeOutput,
            "agent_name": "budget-probe",
            "user_prompt": "probe",
            "config": config,
        }
        if target > (100 if expected is None else expected):
            with pytest.raises(GraphRecursionError):
                await invoke_agent_runtime_graph(**kwargs)
        else:
            assert await invoke_agent_runtime_graph(**kwargs) == ProbeOutput(
                status="ok"
            )
    assert started.call_args.kwargs["recursion_limit"] == (
        100 if expected is None else expected
    )
