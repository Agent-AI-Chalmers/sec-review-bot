import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock, patch, sentinel

import pytest
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.callbacks.manager import CallbackManager

from sec_review_agents.observability.tracing import TracingConfig
from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph


@pytest.mark.asyncio
async def test_invoke_returns_structured_response_after_success(
    tmp_path: Path,
) -> None:
    agent = Mock()
    agent.ainvoke = AsyncMock(return_value={"structured_response": {"status": "ok"}})
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
        transcript_path = tmp_path / "transcript.json"
        result = await invoke_agent_runtime_graph(
            agent=agent,
            agent_name="test-agent",
            system_prompt="",
            user_prompt="prompt",
            config={"metadata": {"scope": "unit"}},
            transcript_paths=(transcript_path,),
        )
        transcript_events = json.loads(transcript_path.read_text(encoding="utf-8"))

    assert result == {"status": "ok"}
    invoke_config = agent.ainvoke.call_args.kwargs["config"]
    assert invoke_config["metadata"] == {
        "scope": "unit",
        "sec_review_agent": "test-agent",
    }
    assert invoke_config["recursion_limit"] == 3
    assert [item["type"] for item in transcript_events] == ["system"]
    assert transcript_events[0]["type"] == "system"


@pytest.mark.asyncio
async def test_transcript_callback_does_not_mark_langfuse_tracing_enabled(
    tmp_path: Path,
) -> None:
    agent = Mock()
    agent.ainvoke = AsyncMock(
        return_value={
            "structured_response": {"status": "ok"},
            "messages": [],
        }
    )
    flush = Mock()
    tracing_config = TracingConfig(
        enabled=False,
        callback=None,
        metadata={"sec_review_agent": "test-agent"},
        run_name="test-agent",
        flush=flush,
    )

    transcript_path = tmp_path / "transcript.json"
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
        transcript_events = json.loads(transcript_path.read_text(encoding="utf-8"))

    started_mock.assert_called_once()
    assert not started_mock.call_args.kwargs["tracing_enabled"]
    assert "callbacks" not in agent.ainvoke.call_args.kwargs["config"]
    assert transcript_events[0]["type"] == "system"
    flush.assert_called_once_with()


@pytest.mark.asyncio
async def test_transcript_export_preserves_callback_manager(
    tmp_path: Path,
) -> None:
    agent = Mock()
    agent.ainvoke = AsyncMock(
        return_value={
            "structured_response": {"status": "ok"},
            "messages": [],
        }
    )
    caller_handler = BaseCallbackHandler()
    callback_manager = CallbackManager([caller_handler])

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
            config={"callbacks": callback_manager},
            transcript_paths=(tmp_path / "transcript.json",),
        )

    invoke_callbacks = agent.ainvoke.call_args.kwargs["config"]["callbacks"]
    assert isinstance(invoke_callbacks, CallbackManager)
    assert caller_handler in invoke_callbacks.handlers
    assert invoke_callbacks.handlers == [caller_handler]


@pytest.mark.asyncio
async def test_invoke_uses_async_agent() -> None:
    ainvoke_calls: list[dict] = []

    async def ainvoke(payload, *, config=None, context=None):
        ainvoke_calls.append(
            {
                "payload": payload,
                "config": config,
                "context": context,
            }
        )
        return {
            "structured_response": {"status": "ok"},
            "messages": payload["messages"],
        }

    agent = Mock()
    agent.ainvoke = AsyncMock(side_effect=ainvoke)

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
    assert len(ainvoke_calls) == 1
    assert ainvoke_calls[0]["payload"] == {
        "messages": [{"role": "user", "content": "prompt"}]
    }


@pytest.mark.asyncio
async def test_invoke_uses_async_agent_without_sync_wrapper() -> None:
    agent = Mock()
    agent.ainvoke = AsyncMock(
        return_value={
            "structured_response": {"status": "ok"},
            "messages": [{"role": "user", "content": "prompt"}],
        }
    )

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
    agent.ainvoke.assert_awaited_once()


@pytest.mark.asyncio
async def test_invoke_logs_failure_and_reraises() -> None:
    agent = Mock()
    agent.ainvoke = AsyncMock(side_effect=RuntimeError("boom"))

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
async def test_missing_structured_response_raises() -> None:
    agent = Mock()
    agent.ainvoke = AsyncMock(
        return_value={
            "messages": [{"role": "assistant", "content": "prose"}],
        }
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

    assert agent.ainvoke.call_count == 1
    failed_mock.assert_called_once()


@pytest.mark.asyncio
async def test_transcript_message_events_cover_legacy_message_dump_fields(
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

    agent = Mock()
    agent.ainvoke = AsyncMock(
        return_value={
            "structured_response": {"status": "ok"},
            "messages": [FakeMessage()],
        }
    )

    transcript_path = tmp_path / "transcript.json"
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
        events = json.loads(transcript_path.read_text(encoding="utf-8"))

    message_events = [item for item in events if item["type"] == "ai"]
    assert len(message_events) == 1
    message = message_events[0]
    assert set(message) == {
        "index",
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
