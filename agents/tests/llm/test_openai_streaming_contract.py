"""Exercise provider streaming through the real SDK without a model service."""

import json
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from langchain_core.messages import AIMessage
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from sec_review_agents.runtime.model_turn_diagnostics import (
    ModelTurnDiagnosticsMiddleware,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("partial", ["", '{"path":'])
async def test_responses_stream_preserves_completed_tool_arguments(
    partial: str,
) -> None:
    """Some endpoints deliver arguments only in done/completed events."""
    arguments = '{"path":"src/app.py"}'
    item = {
        "type": "function_call",
        "id": "fc_1",
        "call_id": "call_1",
        "name": "read_file",
        "arguments": "",
        "status": "in_progress",
    }
    response = {
        "id": "resp_1",
        "object": "response",
        "created_at": 0,
        "model": "gpt-4.1",
        "status": "completed",
        "output": [{**item, "arguments": arguments, "status": "completed"}],
    }
    events: list[dict[str, Any]] = [
        {"type": "response.created", "response": {**response, "output": []}},
        {"type": "response.output_item.added", "output_index": 0, "item": item},
    ]
    if partial:
        events.append(
            {
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_1",
                "output_index": 0,
                "delta": partial,
            }
        )
    events.append({"type": "response.completed", "response": response})
    payload = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/responses"
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=payload
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        model = ChatOpenAI(
            model="gpt-4.1",
            api_key=SecretStr("test"),
            base_url="https://example.test/v1",
            use_responses_api=True,
            http_async_client=client,
        )
        chunks = [chunk async for chunk in model.astream("read the file")]
    message = chunks[0]
    for chunk in chunks[1:]:
        message += chunk
    assert message.tool_calls == [
        {
            "name": "read_file",
            "args": {"path": "src/app.py"},
            "id": "call_1",
            "type": "tool_call",
        }
    ]
    assert message.response_metadata["normalized_finish_reason"] == "tool_call"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("finish_reason", "normalized"),
    [("stop", "stop"), ("length", "length"), ("content_filter", "content_filter")],
)
async def test_v2_events_keep_finish_reason_in_empty_turn_diagnostics(
    finish_reason: str, normalized: str
) -> None:
    """The existing event API and diagnostic must retain provider stop reasons."""
    chunk = {
        "id": "chatcmpl-test",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-4.1",
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": ""},
                "finish_reason": finish_reason,
            }
        ],
    }

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n",
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        model = ChatOpenAI(
            model="gpt-4.1",
            api_key=SecretStr("test"),
            base_url="https://example.test/v1",
            http_async_client=client,
        )
        events = [event async for event in model.astream_events("hello", version="v2")]
    message = next(
        e["data"].get("output") for e in events if e["event"] == "on_chat_model_end"
    )
    assert isinstance(message, AIMessage)
    assert message.response_metadata["finish_reason"] == finish_reason
    assert message.response_metadata["normalized_finish_reason"] == normalized
    with patch(
        "sec_review_agents.runtime.model_turn_diagnostics.log_diagnostic"
    ) as log:
        ModelTurnDiagnosticsMiddleware(agent_name="probe").after_model(
            {"messages": [message]},
            runtime=None,  # type: ignore[arg-type]  # Diagnostics do not access runtime.
        )
    assert log.call_args.kwargs["reason"] == "empty_ai_turn"
    assert (
        log.call_args.kwargs["response_metadata"]["normalized_finish_reason"]
        == normalized
    )
