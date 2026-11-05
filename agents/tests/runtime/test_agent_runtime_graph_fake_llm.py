import tempfile
from pathlib import Path

import pytest
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import BaseModel, Field

from sec_review_agents.runtime.agent_runtime_graph import (
    invoke_agent_runtime_graph,
    run_agent_runtime_graph,
)
from sec_review_agents.runtime.trajectories import read_trajectory_messages
from tests.runtime.fake_chat_models import (
    RecordingToolCallingFakeMessagesListChatModel,
    ToolCallingFakeMessagesListChatModel,
    structured_tool_call_message,
)


class PatchClaimProbeOutput(BaseModel):
    status: str
    changed_files: list[str] = Field()
    rationale: str


def lookup_evidence(query: str) -> str:
    """Look up evidence for a test query."""

    return f"evidence for {query}"


@pytest.mark.asyncio
async def test_structured_output_agent_continues_after_prose_only_model_turn() -> None:
    model = ToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(content="I found the answer but forgot the schema."),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {
                    "status": "applied",
                    "changed_files": ["a.txt"],
                    "rationale": "retry used the structured response tool",
                },
            ),
        ]
    )
    with tempfile.TemporaryDirectory() as tempdir:
        trajectory_path = Path(tempdir) / "trajectory.jsonl"
        result = await run_agent_runtime_graph(
            response_format=PatchClaimProbeOutput,
            model=model,
            backend=None,
            agent_name="fake-missing-structured-response",
            system_prompt="Return the configured structured response.",
            user_prompt="Return a patch claim.",
            trajectory_paths=(trajectory_path,),
        )
        trajectory_messages = read_trajectory_messages(trajectory_path)

    assert result.changed_files == ["a.txt"]
    assert [m["role"] for m in trajectory_messages[:2]] == ["system", "user"]
    assert len([m for m in trajectory_messages if m["role"] == "system"]) == 1
    assert (
        next(
            message for message in trajectory_messages if message["role"] == "assistant"
        )["content"]
        == "I found the answer but forgot the schema."
    )
    assert trajectory_messages[-2]["tool_calls"] == [
        {
            "name": "PatchClaimProbeOutput",
            "args": {
                "status": "applied",
                "changed_files": ["a.txt"],
                "rationale": "retry used the structured response tool",
            },
            "id": "call_1",
            "type": "tool_call",
        }
    ]
    assert trajectory_messages[-1]["role"] == "tool"
    assert trajectory_messages[-1]["name"] == "PatchClaimProbeOutput"


@pytest.mark.asyncio
async def test_trajectory_preserves_messages_replaced_by_summarization(
    tmp_path: Path,
) -> None:
    model = ToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "lookup_evidence",
                        "args": {"query": "redirect"},
                        "id": "call-evidence",
                    }
                ],
            ),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {
                    "status": "confirmed",
                    "changed_files": [],
                    "rationale": "redirect evidence confirmed the finding",
                },
                call_id="call-output",
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[lookup_evidence],
        response_format=PatchClaimProbeOutput,
        middleware=[
            SummarizationMiddleware(
                model=model,
                trigger=("messages", 3),
                keep=("messages", 1),
                summarizer=lambda _messages: "Earlier context inspected redirect evidence.",
            )
        ],
    )
    trajectory_path = tmp_path / "trajectory.jsonl"

    await invoke_agent_runtime_graph(
        response_format=PatchClaimProbeOutput,
        agent=agent,
        agent_name="summarized-trajectory-probe",
        user_prompt="Inspect the redirect target.",
        trajectory_paths=(trajectory_path,),
    )

    messages = read_trajectory_messages(trajectory_path)
    message_ids = [message["id"] for message in messages]
    assert len(message_ids) == len(set(message_ids))
    assert [message["role"] for message in messages] == [
        "user",
        "assistant",
        "tool",
        "user",
        "assistant",
        "tool",
    ]
    assert messages[0]["content"] == "Inspect the redirect target."
    assert messages[3]["additional_kwargs"]["lc_source"] == "summarization"
    assert "Earlier context" in messages[3]["content"]


def test_patch_tool_calls_middleware_repairs_dangling_tool_call_history() -> None:
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[AIMessage(content="done")]
    )
    agent = create_agent(
        model=model,
        tools=[],
        system_prompt="Continue from the provided history.",
        middleware=[PatchToolCallsMiddleware()],
    )

    agent.invoke(
        {
            "messages": [
                HumanMessage("Start the task."),
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "lookup_evidence",
                            "args": {"query": "session"},
                            "id": "call_missing",
                        }
                    ],
                ),
                HumanMessage("Continue after the interrupted tool call."),
            ]
        }
    )

    first_model_batch = model.message_batches[0]
    patched_tool_messages = [
        message
        for message in first_model_batch
        if isinstance(message, ToolMessage) and message.tool_call_id == "call_missing"
    ]
    assert len(patched_tool_messages) == 1
    assert patched_tool_messages[0].name == "lookup_evidence"
    assert patched_tool_messages[0].tool_call_id == "call_missing"
    assert patched_tool_messages[0].status == "error"
    assert patched_tool_messages[0].content


@pytest.mark.asyncio
async def test_invalid_structured_arguments_recover_through_runtime(
    tmp_path: Path,
) -> None:
    """The streaming path must retain the failed turn and recover its result."""
    model = ToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(
                content="",
                invalid_tool_calls=[
                    {
                        "name": "PatchClaimProbeOutput",
                        "args": "{",
                        "id": "invalid-output",
                        "error": "Invalid JSON",
                    }
                ],
            ),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {"status": "applied", "changed_files": [], "rationale": "fixed"},
            ),
        ]
    )
    trajectory_path = tmp_path / "trajectory.jsonl"
    result = await run_agent_runtime_graph(
        response_format=PatchClaimProbeOutput,
        model=model,
        backend=None,
        agent_name="fake-invalid-structured-response",
        system_prompt="Return the configured structured response.",
        user_prompt="Return a patch claim.",
        trajectory_paths=(trajectory_path,),
    )
    assert result.rationale == "fixed"
    messages = read_trajectory_messages(trajectory_path)
    assert any(message.get("invalid_tool_calls") for message in messages)
