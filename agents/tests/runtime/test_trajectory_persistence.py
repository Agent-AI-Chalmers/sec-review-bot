import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.trajectories import (
    TrajectoryWriter,
    parse_trajectory_jsonl,
    read_trajectory_events,
    read_trajectory_messages,
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


def test_trajectory_appends_jsonl_message_events(tmp_path: Path) -> None:
    trajectory_path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((trajectory_path,))

    writer.write_messages([_FakeMessage("first")])
    writer.write_messages([_FakeMessage("second", message_id="msg-2")])

    events = read_trajectory_events(trajectory_path)
    messages = read_trajectory_messages(trajectory_path)
    assert [item["seq"] for item in events] == [1, 2]
    assert [item["event"] for item in events] == ["message", "message"]
    assert [item["content"] for item in messages] == ["first", "second"]


def test_trajectory_writer_fans_out_to_multiple_paths(tmp_path: Path) -> None:
    primary = tmp_path / "stage" / "trajectory.jsonl"
    consumer = tmp_path / "trajectories" / "0001-analyzer-initial.jsonl"
    writer = TrajectoryWriter((primary, consumer))

    writer.write_messages([_FakeMessage("shared")])

    assert primary.read_text(encoding="utf-8") == consumer.read_text(encoding="utf-8")
    messages = read_trajectory_messages(consumer)
    assert messages[0]["content"] == "shared"


def test_trajectory_writes_system_message(tmp_path: Path) -> None:
    trajectory_path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((trajectory_path,))
    writer.write_messages([{"type": "system", "content": "Base system prompt."}])

    message = read_trajectory_messages(trajectory_path)[0]
    assert message["role"] == "system"
    assert message["content"] == "Base system prompt."


def test_trajectory_preserves_tool_result_linkage_and_metadata(tmp_path: Path) -> None:
    trajectory_path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((trajectory_path,))

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

    message = read_trajectory_messages(trajectory_path)[0]
    assert message["tool_call_id"] == "call-1"
    assert message["status"] == "error"
    assert message["artifact"] == {"stderr": "failure detail"}


def test_trajectory_assigns_id_before_deduplicating_message(tmp_path: Path) -> None:
    trajectory_path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((trajectory_path,))
    message = _FakeMessage("repeated", message_id="")

    writer.write_messages([message])
    writer.write_messages([message])

    messages = read_trajectory_messages(trajectory_path)
    assert isinstance(message.id, str) and message.id
    assert [item["id"] for item in messages] == [message.id]


def test_trajectory_uses_object_identity_when_generated_id_cannot_be_persisted(
    tmp_path: Path,
) -> None:
    trajectory_path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((trajectory_path,))
    message = _ImmutableMessage("immutable")

    writer.write_messages([message])
    writer.write_messages([message])

    messages = read_trajectory_messages(trajectory_path)
    assert len(messages) == 1
    assert isinstance(messages[0]["id"], str) and messages[0]["id"]


def test_trajectory_does_not_merge_distinct_idless_immutable_messages(
    tmp_path: Path,
) -> None:
    trajectory_path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((trajectory_path,))

    writer.write_messages(
        [_ImmutableMessage("same content"), _ImmutableMessage("same content")]
    )

    messages = read_trajectory_messages(trajectory_path)
    assert len(messages) == 2
    assert messages[0]["id"] != messages[1]["id"]


@pytest.mark.asyncio
async def test_agent_runtime_graph_records_input_without_inventing_system_message(
    tmp_path: Path,
) -> None:
    class ProbeOutput(BaseModel):
        ok: bool

    trajectory_path = tmp_path / "trajectory.jsonl"
    agent = Mock()

    async def astream(*args: Any, **kwargs: Any):
        _ = args, kwargs
        yield {
            "event": "on_chain_stream",
            "parent_ids": [],
            "data": {"chunk": {"model": {"structured_response": ProbeOutput(ok=True)}}},
        }

    agent.astream_events = astream
    await invoke_agent_runtime_graph(
        response_format=ProbeOutput,
        agent=agent,
        agent_name="test-agent",
        user_prompt="User prompt.",
        trajectory_paths=(trajectory_path,),
    )

    messages = read_trajectory_messages(trajectory_path)
    assert [item["role"] for item in messages] == ["user"]
    assert messages[0]["content"] == "User prompt."


def test_parallel_branches_wait_for_their_own_effective_system(tmp_path):
    """An early sibling graph input must not leak ahead of its system message."""
    path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((path,))
    writer.write_event("model_calls_start")
    humans = {}
    for branch in ("left", "right"):
        human = HumanMessage(content=f"Inspect {branch}.")
        humans[branch] = human
        writer.defer_messages(
            [human],
            run_id=f"{branch}-graph",
            parent_ids=["root", f"dispatch-{branch}"],
            metadata={"lc_agent_name": "reviewer"},
        )
    for branch in ("left", "right"):
        writer.write_execution_event(
            {
                "event": "on_chat_model_start",
                "run_id": f"{branch}-model",
                "parent_ids": [
                    "root",
                    f"dispatch-{branch}",
                    f"{branch}-graph",
                    "model-node",
                ],
                "metadata": {"lc_agent_name": "reviewer"},
                "data": {
                    "input": {
                        "messages": [
                            [
                                SystemMessage(content=f"System for {branch}."),
                                humans[branch],
                            ]
                        ]
                    }
                },
            }
        )
        if branch == "left":
            assert [m["content"] for m in read_trajectory_messages(path)] == [
                "System for left.",
                "Inspect left.",
            ]
    writer.flush_pending_messages()
    messages = read_trajectory_messages(path)
    assert [m["content"] for m in messages] == [
        "System for left.",
        "Inspect left.",
        "System for right.",
        "Inspect right.",
    ]
    assert len({m["id"] for m in messages}) == 4


def test_pre_model_failure_can_flush_deferred_input_without_inventing_system(tmp_path):
    path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((path,))
    human = HumanMessage(content="Review the endpoint.")
    writer.defer_messages([human], agent="reviewer")
    writer.defer_messages([human])
    assert read_trajectory_messages(path) == []
    writer.flush_pending_messages()
    assert [m["content"] for m in read_trajectory_messages(path)] == [
        "Review the endpoint."
    ]


@pytest.mark.asyncio
async def test_cancellation_before_first_model_call_preserves_deferred_input(tmp_path):
    """Waiting for the effective system must not discard input on cancellation."""

    class ProbeOutput(BaseModel):
        ok: bool

    agent = Mock()

    async def events(payload, **kwargs):
        yield {
            "event": "on_chain_start",
            "run_id": "root",
            "parent_ids": [],
            "data": {"input": payload},
        }
        await asyncio.Event().wait()

    agent.astream_events = events
    path = tmp_path / "trajectory.jsonl"
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(
            invoke_agent_runtime_graph(
                agent=agent,
                response_format=ProbeOutput,
                agent_name="reviewer",
                user_prompt="Review the endpoint.",
                trajectory_paths=(path,),
            ),
            timeout=0.05,
        )
    assert [m["content"] for m in read_trajectory_messages(path)] == [
        "Review the endpoint."
    ]
    assert read_trajectory_events(path)[-1]["status"] == "interrupted"


@pytest.mark.parametrize(
    "record",
    [
        {
            "seq": 1,
            "event": "message",
            "message": {"id": "m", "type": "human", "content": "old"},
        },
        {
            "seq": 1,
            "event": "message",
            "message": {"id": "m", "role": "human", "content": "old"},
        },
        {
            "seq": 1,
            "event": "message",
            "message": {"role": "user", "content": "missing ID"},
        },
        {
            "seq": True,
            "event": "message",
            "message": {"id": "m", "role": "user", "content": "bad sequence"},
        },
        {"messages": [{"role": "user", "content": "wrapper"}]},
        [{"role": "user", "content": "array"}],
    ],
)
def test_trajectory_reader_rejects_noncanonical_records(tmp_path, record):
    import json

    path = tmp_path / "trajectory.jsonl"
    path.write_text(json.dumps(record) + "\n")
    with pytest.raises(ValueError):
        read_trajectory_events(path)


def test_trajectory_producer_writes_canonical_roles_and_provenance(tmp_path):
    from langchain_core.messages import AIMessage

    path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((path,), agent="parent")
    writer.write_event("model_calls_start")
    writer.write_execution_event(
        {
            "event": "on_chat_model_start",
            "run_id": "child-model",
            "parent_ids": ["root", "delegation"],
            "metadata": {
                "lc_agent_name": "child",
                "lc_source": "summarization",
                "sec_review_agent": "parent",
            },
            "data": {"input": {"messages": []}},
        }
    )
    writer.write_execution_event(
        {
            "event": "on_chat_model_end",
            "run_id": "child-model",
            "parent_ids": ["root", "delegation"],
            "metadata": {
                "lc_agent_name": "child",
                "lc_source": "summarization",
                "sec_review_agent": "parent",
            },
            "data": {"output": AIMessage(content="summary")},
        }
    )
    response = next(
        event for event in read_trajectory_events(path) if event["event"] == "message"
    )
    assert response["agent"] == "child"
    assert response["source"] == "summarization"
    assert response["message"]["role"] == "assistant"
    assert "type" not in response["message"]
    assert response["metadata"]["sec_review_agent"] == "parent"


def test_system_deduplication_preserves_changes_and_independent_branches(tmp_path):
    from langchain_core.messages import SystemMessage

    writer = TrajectoryWriter((tmp_path / "systems.jsonl",))
    for branch, content in [
        ("left", "A"),
        ("left", "A"),
        ("right", "A"),
        ("left", "B"),
        ("left", "A"),
    ]:
        writer.write_messages(
            [SystemMessage(content=content)],
            agent="reviewer",
            parent_ids=["root", branch, "model"],
        )
    messages = read_trajectory_messages(writer.path)
    assert [message["content"] for message in messages] == ["A", "A", "B", "A"]


@pytest.mark.parametrize("separator", ["\u0085", "\u2028", "\u2029"])
def test_trajectory_round_trip_preserves_unicode_separators(
    tmp_path: Path, separator: str
) -> None:
    """Tool output may contain Unicode separators without starting a JSONL record."""
    path = tmp_path / "trajectory.jsonl"
    writer = TrajectoryWriter((path,))
    content = f"before{separator}after"
    writer.write_messages([_FakeMessage(content)])
    writer.write_messages([_FakeMessage("next", message_id="msg-2")])

    assert [message["content"] for message in read_trajectory_messages(path)] == [
        content,
        "next",
    ]


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
@pytest.mark.parametrize("trailing_newline", [False, True])
def test_trajectory_record_delimiters(newline: str, trailing_newline: bool) -> None:
    import json

    records = [
        {
            "seq": index,
            "event": "message",
            "message": {
                "id": f"m{index}",
                "role": "user",
                "content": "a\u0085b\u2028c\u2029d",
            },
        }
        for index in (1, 2)
    ]
    content = newline.join(json.dumps(record, ensure_ascii=False) for record in records)
    if trailing_newline:
        content += newline
    assert parse_trajectory_jsonl(content) == records
