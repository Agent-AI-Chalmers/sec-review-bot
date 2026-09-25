import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.transcripts import (
    TranscriptCallbackHandler,
    TranscriptWriter,
)


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.type = "human"
        self.id = "msg-1"
        self.name = None
        self.content = content
        self.additional_kwargs: dict[str, Any] = {}
        self.response_metadata: dict[str, Any] = {}
        self.tool_calls: list[dict[str, Any]] = []
        self.invalid_tool_calls: list[dict[str, Any]] = []
        self.tool_call_chunks: list[dict[str, Any]] = []
        self.usage_metadata = None


def test_transcript_writes_jsonl_message_events(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,), agent_name="test-agent")

    writer.write_messages([_FakeMessage("first")])
    writer.write_messages([_FakeMessage("second")])

    events = [
        json.loads(line)
        for line in transcript_path.read_text(encoding="utf-8").splitlines()
    ]

    assert [item["seq"] for item in events] == [1, 2]
    assert [item["event"] for item in events] == ["message", "message"]
    assert events[0]["agent"] == "test-agent"
    assert events[0]["message"]["content"] == "first"
    assert events[1]["message"]["content"] == "second"


def test_transcript_writer_fans_out_to_multiple_paths(tmp_path: Path) -> None:
    primary = tmp_path / "stage" / "transcript.jsonl"
    consumer = tmp_path / "transcripts" / "0001-review" / "0001-analyzer-initial.jsonl"
    writer = TranscriptWriter((primary, consumer), agent_name="test-agent")

    writer.write_event("agent_start")
    writer.write_event("agent_end", status="ok")

    assert primary.read_text(encoding="utf-8") == consumer.read_text(encoding="utf-8")
    events = [
        json.loads(line) for line in consumer.read_text(encoding="utf-8").splitlines()
    ]
    assert [item["seq"] for item in events] == [1, 2]


def test_transcript_model_start_does_not_repeat_full_message_history(
    tmp_path: Path,
) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,), agent_name="test-agent")
    callback = TranscriptCallbackHandler(writer)

    callback.on_chat_model_start(
        {"name": "test-model"},
        [[_FakeMessage("the accumulated history")]],
        run_id="model-run",
    )

    event = json.loads(transcript_path.read_text(encoding="utf-8"))
    assert event["event"] == "model_start"
    assert event["model"] == "test-model"
    assert "messages" not in event


@pytest.mark.asyncio
async def test_agent_runtime_graph_writes_prompt_snapshot(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    agent = Mock()
    agent.ainvoke = AsyncMock(
        return_value={
            "messages": [{"role": "human", "content": "User prompt."}],
            "structured_response": {"ok": True},
        }
    )
    await invoke_agent_runtime_graph(
        agent=agent,
        agent_name="test-agent",
        system_prompt="Base system prompt.",
        user_prompt="User prompt.",
        transcript_paths=(transcript_path,),
    )

    events = [
        json.loads(line)
        for line in transcript_path.read_text(encoding="utf-8").splitlines()
    ]
    prompt_event = next(item for item in events if item["event"] == "prompt_snapshot")
    assert prompt_event["system_prompt"] == "Base system prompt."
    assert set(prompt_event) - {"agent", "seq", "timestamp", "ts"} == {
        "event",
        "system_prompt",
    }
