from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from langchain_core.messages import ToolMessage

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.transcripts import (
    TranscriptWriter,
    read_transcript_events,
    read_transcript_messages,
)


class _FakeMessage:
    def __init__(self, content: str, *, message_id: str = "msg-1") -> None:
        self.type = "human"
        self.id = message_id
        self.name = None
        self.content = content
        self.additional_kwargs: dict[str, Any] = {}
        self.response_metadata: dict[str, Any] = {}
        self.tool_calls: list[dict[str, Any]] = []
        self.invalid_tool_calls: list[dict[str, Any]] = []
        self.tool_call_chunks: list[dict[str, Any]] = []
        self.usage_metadata = None


class _ImmutableMessage:
    __slots__ = ("content", "type")

    def __init__(self, content: str) -> None:
        self.type = "human"
        self.content = content


def test_transcript_appends_jsonl_message_events(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,))

    writer.write_messages([_FakeMessage("first")])
    writer.write_messages([_FakeMessage("second", message_id="msg-2")])

    events = read_transcript_events(transcript_path)
    messages = read_transcript_messages(transcript_path)
    assert [item["seq"] for item in events] == [1, 2]
    assert [item["event"] for item in events] == ["message", "message"]
    assert [item["content"] for item in messages] == ["first", "second"]


def test_transcript_writer_fans_out_to_multiple_paths(tmp_path: Path) -> None:
    primary = tmp_path / "stage" / "transcript.jsonl"
    consumer = tmp_path / "transcripts" / "0001-analyzer-initial.jsonl"
    writer = TranscriptWriter((primary, consumer))

    writer.write_messages([_FakeMessage("shared")])

    assert primary.read_text(encoding="utf-8") == consumer.read_text(encoding="utf-8")
    messages = read_transcript_messages(consumer)
    assert messages[0]["content"] == "shared"


def test_transcript_writes_system_message(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,))
    writer.write_messages([{"type": "system", "content": "Base system prompt."}])

    message = read_transcript_messages(transcript_path)[0]
    assert message["type"] == "system"
    assert message["content"] == "Base system prompt."


def test_transcript_preserves_tool_result_linkage_and_metadata(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,))

    writer.write_messages(
        [
            ToolMessage(
                content="tool output",
                tool_call_id="call-1",
                name="inspect",
                status="error",
                artifact={"stderr": "failure detail"},
            )
        ]
    )

    message = read_transcript_messages(transcript_path)[0]
    assert message["tool_call_id"] == "call-1"
    assert message["status"] == "error"
    assert message["artifact"] == {"stderr": "failure detail"}


def test_transcript_assigns_id_before_deduplicating_message(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,))
    message = _FakeMessage("repeated", message_id="")

    writer.write_messages([message])
    writer.write_messages([message])

    messages = read_transcript_messages(transcript_path)
    assert isinstance(message.id, str) and message.id
    assert [item["id"] for item in messages] == [message.id]


def test_transcript_uses_object_identity_when_generated_id_cannot_be_persisted(
    tmp_path: Path,
) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,))
    message = _ImmutableMessage("immutable")

    writer.write_messages([message])
    writer.write_messages([message])

    messages = read_transcript_messages(transcript_path)
    assert len(messages) == 1
    assert isinstance(messages[0]["id"], str) and messages[0]["id"]


def test_transcript_does_not_merge_distinct_idless_immutable_messages(
    tmp_path: Path,
) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    writer = TranscriptWriter((transcript_path,))

    writer.write_messages(
        [_ImmutableMessage("same content"), _ImmutableMessage("same content")]
    )

    messages = read_transcript_messages(transcript_path)
    assert len(messages) == 2
    assert messages[0]["id"] != messages[1]["id"]


@pytest.mark.asyncio
async def test_agent_runtime_graph_prepends_system_message(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.jsonl"
    agent = Mock()

    async def astream(*args: Any, **kwargs: Any):
        _ = args, kwargs
        yield {"model": {"structured_response": {"ok": True}}}

    agent.astream = astream
    await invoke_agent_runtime_graph(
        agent=agent,
        agent_name="test-agent",
        system_prompt="Base system prompt.",
        user_prompt="User prompt.",
        transcript_paths=(transcript_path,),
    )

    messages = read_transcript_messages(transcript_path)
    assert [item["type"] for item in messages] == ["system", "human"]
    assert messages[0]["content"] == "Base system prompt."
