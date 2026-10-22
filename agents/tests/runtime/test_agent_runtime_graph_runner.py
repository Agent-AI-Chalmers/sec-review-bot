from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch, sentinel

import pytest
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.callbacks.manager import CallbackManager

from sec_review_agents.observability.tracing import TracingConfig
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.transcripts import read_transcript_messages


def _stream(*updates: dict[str, Any], error: Exception | None = None):
    async def astream(*args: Any, **kwargs: Any):
        _ = args, kwargs
        for update in updates:
            yield update
        if error is not None:
            raise error

    return astream


def _successful_agent(*, messages: list[Any] | None = None) -> Mock:
    agent = Mock()
    agent.astream = Mock(
        side_effect=_stream(
            {
                "model": {
                    "messages": messages or [],
                    "structured_response": {"status": "ok"},
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
        transcript_path = tmp_path / "transcript.jsonl"
        result = await invoke_agent_runtime_graph(
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
            config={"metadata": {"scope": "unit"}},
            transcript_paths=(transcript_path,),
        )
        transcript_messages = read_transcript_messages(transcript_path)

    assert result == {"status": "ok"}
    invoke_config = agent.astream.call_args.kwargs["config"]
    assert invoke_config["metadata"] == {
        "scope": "unit",
        "sec_review_agent": "test-agent",
    }
    assert invoke_config["recursion_limit"] == 3
    assert [item["type"] for item in transcript_messages] == ["system", "human"]
    assert transcript_messages[0]["type"] == "system"


@pytest.mark.asyncio
async def test_transcript_callback_does_not_mark_langfuse_tracing_enabled(
    tmp_path: Path,
) -> None:
    agent = _successful_agent()
    flush = Mock()
    tracing_config = TracingConfig(
        enabled=False,
        callback=None,
        metadata={"sec_review_agent": "test-agent"},
        run_name="test-agent",
        flush=flush,
    )

    transcript_path = tmp_path / "transcript.jsonl"
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
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
            transcript_paths=(transcript_path,),
        )
        transcript_messages = read_transcript_messages(transcript_path)

    started_mock.assert_called_once()
    assert not started_mock.call_args.kwargs["tracing_enabled"]
    assert "callbacks" not in agent.astream.call_args.kwargs["config"]
    assert transcript_messages[0]["type"] == "system"
    flush.assert_called_once_with()


@pytest.mark.asyncio
async def test_transcript_export_preserves_callback_manager(
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
        flush=lambda: None,
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
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
            config={"callbacks": callback_manager},
            transcript_paths=(tmp_path / "transcript.jsonl",),
        )

    invoke_callbacks = agent.astream.call_args.kwargs["config"]["callbacks"]
    assert isinstance(invoke_callbacks, CallbackManager)
    assert caller_handler in invoke_callbacks.handlers
    assert invoke_callbacks.handlers == [caller_handler]


@pytest.mark.asyncio
async def test_invoke_uses_async_agent_stream() -> None:
    astream_calls: list[dict] = []

    async def astream(payload, *, config=None, stream_mode=None):
        astream_calls.append(
            {
                "payload": payload,
                "config": config,
                "stream_mode": stream_mode,
            }
        )
        yield {"model": {"structured_response": {"status": "ok"}}}

    agent = Mock()
    agent.astream = astream

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
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
        )

    assert result == {"status": "ok"}
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
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
        )

    assert result == {"status": "ok"}
    agent.astream.assert_called_once()


@pytest.mark.asyncio
async def test_invoke_logs_failure_and_reraises() -> None:
    agent = Mock()
    agent.astream = Mock(side_effect=_stream(error=RuntimeError("boom")))

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
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
        )

    failed_mock.assert_called_once()


@pytest.mark.asyncio
async def test_stream_failure_preserves_completed_message_updates(
    tmp_path: Path,
) -> None:
    agent = Mock()
    agent.astream = Mock(
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
    transcript_path = tmp_path / "transcript.jsonl"

    with pytest.raises(RuntimeError, match="boom"):
        await invoke_agent_runtime_graph(
            agent=agent,
            agent_name="test-agent",
            system_prompt="system",
            user_prompt="prompt",
            transcript_paths=(transcript_path,),
        )

    messages = read_transcript_messages(transcript_path)
    assert [message["content"] for message in messages] == [
        "system",
        "prompt",
        "Evidence collected before failure.",
    ]


@pytest.mark.asyncio
async def test_missing_structured_response_raises() -> None:
    agent = Mock()
    agent.astream = Mock(
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
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
        )

    assert agent.astream.call_count == 1
    failed_mock.assert_called_once()


@pytest.mark.asyncio
async def test_transcript_messages_cover_message_dump_fields(
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

    transcript_path = tmp_path / "transcript.jsonl"
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
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
            transcript_paths=(transcript_path,),
        )
        messages = read_transcript_messages(transcript_path)

    ai_messages = [item for item in messages if item["type"] == "ai"]
    assert len(ai_messages) == 1
    message = ai_messages[0]
    assert set(message) == {
        "type",
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
