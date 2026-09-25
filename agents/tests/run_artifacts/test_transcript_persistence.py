import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.transcripts import TranscriptWriter


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


def test_transcript_writes_flat_message_array(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.json"
    writer = TranscriptWriter((transcript_path,), agent_name="test-agent")

    writer.write_messages([_FakeMessage("first")])
    writer.write_messages([_FakeMessage("second")])

    messages = json.loads(transcript_path.read_text(encoding="utf-8"))
    assert [item["index"] for item in messages] == [0, 1]
    assert [item["content"] for item in messages] == ["first", "second"]


def test_transcript_writer_fans_out_to_multiple_paths(tmp_path: Path) -> None:
    primary = tmp_path / "stage" / "transcript.json"
    consumer = tmp_path / "transcripts" / "0001-review" / "0001-analyzer-initial.json"
    writer = TranscriptWriter((primary, consumer), agent_name="test-agent")

    writer.write_messages([_FakeMessage("shared")])

    assert primary.read_text(encoding="utf-8") == consumer.read_text(encoding="utf-8")
    messages = json.loads(consumer.read_text(encoding="utf-8"))
    assert messages[0]["content"] == "shared"


def test_transcript_exports_system_prompt_as_first_message(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.json"
    writer = TranscriptWriter((transcript_path,), agent_name="test-agent")
    writer.write_system_prompt("Base system prompt.")

    message = json.loads(transcript_path.read_text(encoding="utf-8"))[0]
    assert message["index"] == 0
    assert message["type"] == "system"
    assert message["content"] == "Base system prompt."


@pytest.mark.asyncio
async def test_agent_runtime_graph_prepends_system_message(tmp_path: Path) -> None:
    transcript_path = tmp_path / "transcript.json"
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

    messages = json.loads(transcript_path.read_text(encoding="utf-8"))
    assert [item["type"] for item in messages] == ["system", "human"]
    assert messages[0]["content"] == "Base system prompt."
