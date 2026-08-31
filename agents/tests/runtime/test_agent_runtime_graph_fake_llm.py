import json
import tempfile
from pathlib import Path
from typing import Any

import pytest
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import BaseModel, Field

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.changed_files_acceptance_middleware import (
    ChangedFilesAcceptanceMiddleware,
)
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
)
from tests.llm.fake_chat_models import (
    ToolCallingFakeMessagesListChatModel,
    structured_tool_call_message,
)
from tests.review_stages.stages.test_mitigation_changed_files_acceptance import (
    _baseline_snapshot,
    _copy_repo,
    _create_repo,
)


class PatchClaimProbeOutput(BaseModel):
    status: str
    changed_files: list[str] = Field()
    rationale: str


class DeclaredPatchProbeOutput(BaseModel):
    status: str
    declared_changed_files: list[str] = Field()
    rationale: str


class RecordingToolCallingFakeMessagesListChatModel(
    ToolCallingFakeMessagesListChatModel
):
    message_batches: list[list[Any]] = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.message_batches.append(list(messages))
        return super()._generate(
            messages,
            stop=stop,
            run_manager=run_manager,
            **kwargs,
        )


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
    agent = create_agent(
        model=model,
        tools=[],
        response_format=PatchClaimProbeOutput,
        system_prompt="Return the configured structured response.",
    )
    with tempfile.TemporaryDirectory() as tempdir:
        transcript_path = Path(tempdir) / "transcript.jsonl"
        result = await invoke_agent_runtime_graph(
            agent=agent,
            agent_name="fake-missing-structured-response",
            system_prompt="Return the configured structured response.",
            user_prompt="Return a patch claim.",
            transcript_paths=(transcript_path,),
        )
        message_events = [
            json.loads(line)["message"]
            for line in transcript_path.read_text(encoding="utf-8").splitlines()
            if json.loads(line)["event"] == "message"
        ]

    assert result["changed_files"] == ["a.txt"]
    assert message_events[1]["content"] == "I found the answer but forgot the schema."
    assert "Returning structured response" in message_events[-1]["content"]


def test_missing_structured_response_middleware_keeps_tool_agent_in_one_invoke() -> (
    None
):
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            AIMessage(content="I found the answer but forgot the schema."),
            structured_tool_call_message(
                PatchClaimProbeOutput,
                {
                    "status": "applied",
                    "changed_files": ["a.txt"],
                    "rationale": "middleware requested structured response",
                },
            ),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[lookup_evidence],
        response_format=PatchClaimProbeOutput,
        system_prompt="Return the configured structured response.",
        middleware=[MissingStructuredResponseMiddleware()],
    )
    result = agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})

    structured = result["structured_response"]
    assert structured.changed_files == ["a.txt"]
    assert len(model.message_batches) == 2
    assert model.message_batches[0][-1].content == "Return a patch claim."
    assert (
        "did not include the required structured response"
        in model.message_batches[1][-1].content
    )


def test_changed_files_acceptance_middleware_retries_in_one_invoke() -> None:
    with tempfile.TemporaryDirectory() as tempdir:
        local_root = Path(tempdir) / "local"
        source_workspace = local_root / "workspace"
        workspace = Path(tempdir) / "writable-workspace"
        _create_repo(
            source_workspace,
            {
                "a.txt": "old\n",
                "b.txt": "old\n",
            },
        )
        _copy_repo(source_workspace, workspace)
        (workspace / "a.txt").write_text("new\n", encoding="utf-8")
        model = RecordingToolCallingFakeMessagesListChatModel(
            responses=[
                structured_tool_call_message(
                    DeclaredPatchProbeOutput,
                    {
                        "status": "applied",
                        "declared_changed_files": ["b.txt"],
                        "rationale": "first response mismatches workspace",
                    },
                    call_id="call_1",
                ),
                structured_tool_call_message(
                    DeclaredPatchProbeOutput,
                    {
                        "status": "applied",
                        "declared_changed_files": ["a.txt"],
                        "rationale": "corrected response matches workspace",
                    },
                    call_id="call_2",
                ),
            ]
        )
        agent = create_agent(
            model=model,
            tools=[lookup_evidence],
            response_format=DeclaredPatchProbeOutput,
            system_prompt="Return the configured structured response.",
            middleware=[
                ChangedFilesAcceptanceMiddleware(
                    worktree_path=workspace,
                    baseline_snapshot_tar_path=_baseline_snapshot(
                        local_root,
                        Path(tempdir) / "artifacts" / "run-1",
                    ),
                )
            ],
        )

        result = agent.invoke({"messages": [HumanMessage("Return a patch claim.")]})

    structured = result["structured_response"]
    assert structured.declared_changed_files == ["a.txt"]
    assert len(model.message_batches) == 2
    assert "Patch reconciliation failed" in model.message_batches[1][-1].content


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
    assert "was cancelled" in patched_tool_messages[0].content
