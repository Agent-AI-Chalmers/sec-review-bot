"""Internal calls must remain accountable without becoming parent conversation messages."""

import asyncio
from typing import Any, TypedDict

import pytest
from deepagents.backends import FilesystemBackend
from deepagents.middleware.subagents import SubAgentMiddleware
from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from sec_review_agents.runtime.agent_runtime_graph import invoke_agent_runtime_graph
from sec_review_agents.runtime.trajectories import (
    read_trajectory_events,
    read_trajectory_messages,
)


class Output(BaseModel):
    answer: str


class State(TypedDict, total=False):
    messages: list
    structured_response: Output


class Model(BaseChatModel):
    role: str = "parent"
    behavior: str = "normal"

    @property
    def _llm_type(self) -> str:
        return "model-call-test"

    def bind_tools(self, *args: Any, **kwargs: Any):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        calls = []
        if self.role == "parent" and not any(
            isinstance(m, ToolMessage) for m in messages
        ):
            calls = [
                {
                    "name": "task",
                    "args": {"description": "Reply OK", "subagent_type": "child"},
                    "id": f"task-{i}",
                    "type": "tool_call",
                }
                for i in range(2)
            ]
        response = AIMessage(
            content="OK",
            tool_calls=calls,
            usage_metadata={"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
            response_metadata={"model_name": self.role},
        )
        return ChatResult(generations=[ChatGeneration(message=response)])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        if self.behavior == "normal":
            response = self._generate(messages).generations[0].message
            assert isinstance(response, AIMessage)
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content=response.content, tool_calls=response.tool_calls
                )
            )
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    usage_metadata=response.usage_metadata,
                    response_metadata=response.response_metadata,
                )
            )
        else:
            yield ChatGenerationChunk(message=AIMessageChunk(content="partial"))
            if self.behavior == "failure":
                raise RuntimeError("model failed")
            if self.behavior == "cancel":
                await asyncio.sleep(30)


async def invoke(node, path):
    graph = StateGraph(State)
    graph.add_node("work", node)
    graph.add_edge(START, "work")
    graph.add_edge("work", END)
    return await invoke_agent_runtime_graph(
        agent=graph.compile(),
        response_format=Output,
        agent_name="probe",
        user_prompt="user",
        trajectory_paths=(path,),
    )


@pytest.mark.asyncio
async def test_summary_and_parallel_subagent_calls_are_recorded_without_langfuse(
    tmp_path, monkeypatch
):
    for key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(key, raising=False)
    agent = create_agent(
        model=Model(),
        middleware=[
            SummarizationMiddleware(
                model=Model(role="summary"),
                trigger=("messages", 8),
                keep=("messages", 1),
            ),
            SubAgentMiddleware(
                backend=FilesystemBackend(root_dir=tmp_path),
                subagents=[
                    {
                        "name": "child",
                        "description": "child",
                        "model": Model(role="child"),
                        "tools": [],
                    }
                ],
            ),
        ],
    )

    async def work(state):
        history = [
            HumanMessage(content="history") if i % 2 == 0 else AIMessage(content="old")
            for i in range(9)
        ]
        payload: Any = {"messages": history}
        result = await agent.ainvoke(payload)
        return {
            "messages": [result["messages"][-1]],
            "structured_response": Output(answer="OK"),
        }

    path = tmp_path / "trajectory.jsonl"
    assert await invoke(work, path) == Output(answer="OK")
    events = read_trajectory_events(path)
    starts = [e for e in events if e["event"] == "model_call_start"]
    ends = [e for e in events if e["event"] == "model_call_end"]
    assert len(starts) == len(ends) == 5
    assert {e["call_id"] for e in starts} == {e["call_id"] for e in ends}
    assert (
        sum(
            e["message"]["usage_metadata"]["total_tokens"]
            for e in events
            if e["event"] == "message" and e.get("call_id")
        )
        == 60
    )
    assert (
        len([e for e in ends if e["metadata"].get("lc_source") == "summarization"]) == 1
    )
    assert all(e["parent_ids"] for e in ends)
    assert events[-1]["status"] == "completed"
    messages = read_trajectory_messages(path)
    assert len({m["id"] for m in messages}) == len(messages)
    by_id = {m["id"]: m for m in messages}
    assert all(e["message_id"] in by_id for e in ends)
    assert len([m for m in messages if m["role"] == "assistant"]) == 9
    assert len([m for m in messages if m["role"] == "tool"]) == 2
    assert all("response" not in e for e in ends)


@pytest.mark.asyncio
@pytest.mark.parametrize("behavior", ["failure", "cancel", "missing"])
async def test_unfinished_or_usage_less_calls_are_preserved(tmp_path, behavior):
    model = Model(role="child", behavior=behavior)

    async def work(state):
        response = await model.ainvoke("probe")
        return {"messages": [response], "structured_response": Output(answer="OK")}

    path = tmp_path / "trajectory.jsonl"
    if behavior == "failure":
        with pytest.raises(RuntimeError, match="model failed"):
            await invoke(work, path)
    elif behavior == "cancel":
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(invoke(work, path), timeout=0.2)
    else:
        await invoke(work, path)
    events = read_trajectory_events(path)
    assert len([e for e in events if e["event"] == "model_call_start"]) == 1
    ends = [e for e in events if e["event"] == "model_call_end"]
    assert len(ends) == (1 if behavior == "missing" else 0)
    if ends:
        response = next(
            e["message"] for e in events if e["event"] == "message" and e.get("call_id")
        )
        assert response["usage_metadata"] is None
    assert (
        events[-1]["status"]
        == {"failure": "failed", "cancel": "interrupted", "missing": "completed"}[
            behavior
        ]
    )


@pytest.mark.asyncio
async def test_nested_tools_and_memory_reader_share_single_response_records(
    tmp_path, monkeypatch
):
    from langchain_core.tools import tool

    from sec_review_agents.agents.memory_extractor.tools import build_trajectory_tools

    @tool
    def inspect_file() -> str:
        """Return evidence for the probe."""
        return "evidence"

    class Child(Model):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            result = super()._generate(messages, stop, run_manager, **kwargs)
            response = result.generations[0].message
            assert isinstance(response, AIMessage)
            if not any(isinstance(m, ToolMessage) for m in messages):
                response.tool_calls = [
                    {
                        "name": "inspect_file",
                        "args": {},
                        "id": "reused-in-each-child",
                        "type": "tool_call",
                    }
                ]
            return result

    for key in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"):
        monkeypatch.delenv(key, raising=False)
    agent = create_agent(
        model=Model(),
        middleware=[
            SubAgentMiddleware(
                backend=FilesystemBackend(root_dir=tmp_path),
                subagents=[
                    {
                        "name": "child",
                        "description": "child",
                        "model": Child(role="child"),
                        "tools": [inspect_file],
                    }
                ],
            )
        ],
    )

    async def work(state):
        result = await agent.ainvoke({"messages": [HumanMessage(content="delegate")]})
        return {
            "messages": [result["messages"][-1]],
            "structured_response": Output(answer="OK"),
        }

    path = tmp_path / "trajectories/probe.jsonl"
    await invoke(work, path)
    events = read_trajectory_events(path)
    messages = [e for e in events if e["event"] == "message"]
    generated = [e for e in messages if e.get("call_id")]
    assert len(generated) == 6
    assert len({e["message"]["id"] for e in messages}) == len(messages)
    results = [
        e
        for e in messages
        if e["message"].get("tool_call_id") == "reused-in-each-child"
    ]
    assert len(results) == 2
    assert results[0]["parent_ids"] != results[1]["parent_ids"]
    assert len([e for e in messages if e["message"]["role"] == "tool"]) == 4
    tools = {
        t.name: t
        for t in build_trajectory_tools(
            FilesystemBackend(root_dir=tmp_path, virtual_mode=True)
        )
    }
    listing = tools["list_trajectory_messages"].invoke(
        {"file_path": "/trajectories/probe.jsonl"}
    )
    assert len(listing["messages"]) == len(messages)
    child = next(e for e in generated if e["metadata"].get("lc_agent_name") == "child")
    detail = tools["read_trajectory_message"].invoke(
        {"file_path": "/trajectories/probe.jsonl", "seq": child["seq"]}
    )
    assert detail["call_id"] == child["call_id"]
    assert detail["message"]["usage_metadata"]["total_tokens"] == 12
    assert detail["agent"] == "child"


@pytest.mark.asyncio
async def test_system_messages_follow_actual_model_inputs_after_middleware(tmp_path):
    """A configured prompt is not evidence of what a middleware-modified call received."""
    from langchain.agents.middleware import dynamic_prompt

    inputs = []

    class CapturingModel(Model):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            inputs.append(list(messages))
            return super()._generate(messages, stop, run_manager, **kwargs)

    @dynamic_prompt
    def review_prompt(request):
        return "Actual review prompt selected by middleware."

    agent = create_agent(
        model=CapturingModel(role="child"),
        system_prompt="Configured prompt replaced before the model call.",
        middleware=[review_prompt],
    )

    async def work(state):
        result = await agent.ainvoke({"messages": state["messages"]})
        return {
            "messages": [result["messages"][-1]],
            "structured_response": Output(answer="OK"),
        }

    path = tmp_path / "trajectory.jsonl"
    await invoke(work, path)
    messages = read_trajectory_messages(path)
    systems = [m for m in messages if m["role"] == "system"]
    assert len(inputs) == 1
    assert [m.type for m in inputs[0]] == ["system", "human"]
    assert [m["content"] for m in systems] == [inputs[0][0].content]
    assert systems[0]["content"] == "Actual review prompt selected by middleware."
    assert [m["role"] for m in messages[:2]] == ["system", "user"]
    assert [m["content"] for m in messages[:2]] == [m.content for m in inputs[0]]
