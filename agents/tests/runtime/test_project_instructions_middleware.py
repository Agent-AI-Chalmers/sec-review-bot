from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from deepagents.backends.protocol import BackendProtocol, ReadResult
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import InputAgentState
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import Field

from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.path_views import workspace_view
from sec_review_agents.runtime.memory_middleware import MemoryMiddleware
from sec_review_agents.runtime.project_instructions_middleware import (
    REPOSITORY_INSTRUCTIONS_MAX_CHARS,
    REPOSITORY_INSTRUCTIONS_MAX_LINES,
    REPOSITORY_INSTRUCTIONS_SYSTEM_PROMPT,
    ProjectInstructionsMiddleware,
)
from tests.runtime.fake_chat_models import ToolCallingFakeMessagesListChatModel


class RecordingModel(ToolCallingFakeMessagesListChatModel):
    batches: list[list[Any]] = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.batches.append(list(messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


@pytest.fixture
def backend(tmp_path: Path) -> BackendProtocol:
    return create_backend_with_path_views(
        container_name_prefix="repository-instructions-test",
        backend_kind="local",
        path_views=[workspace_view(host_path=tmp_path)],
    )


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.asyncio
async def test_guidance_is_loaded_without_tool_calls_and_refreshed_on_resume(
    tmp_path: Path, backend: BackendProtocol, asynchronous: bool
) -> None:
    """A checkpoint must not keep old guidance after a file changes or disappears."""
    instructions = tmp_path / "AGENTS.md"
    instructions.write_text("Use the public API tests.\n<!-- maintainer note -->\n")
    model = RecordingModel(responses=[AIMessage(content="done")])
    middleware: list[AgentMiddleware[Any, Any, Any]] = [
        ProjectInstructionsMiddleware(backend=backend),
        MemoryMiddleware(),
    ]
    agent = create_agent(
        model=model,
        system_prompt=SystemMessage(
            content=[
                {"type": "text", "text": "Stage role."},
                {"type": "text", "text": "Evidence contract."},
            ]
        ),
        middleware=middleware,
        checkpointer=InMemorySaver(),
    )
    config: RunnableConfig = {"configurable": {"thread_id": "review"}}
    for content in ["Use the public API tests.", "Use the compatibility tests.", None]:
        if content is None:
            instructions.unlink()
        elif content != "Use the public API tests.":
            instructions.write_text(content)
        task: InputAgentState = {
            "messages": [HumanMessage(content="Review the scoped change.")]
        }
        if asynchronous:
            await agent.ainvoke(task, config)
        else:
            agent.invoke(task, config)
        batch = model.batches[-1]
        system = batch[0]
        assert isinstance(system, SystemMessage)
        texts = [block.get("text") for block in system.content_blocks]
        assert texts[:2] == ["Stage role.", "Evidence contract."]
        if content is not None:
            assert isinstance(texts[2], str)
            assert REPOSITORY_INSTRUCTIONS_SYSTEM_PROMPT in texts[2]
            assert content in texts[2]
            assert "maintainer note" not in texts[2]
            assert len(texts) == 4  # Repository guidance precedes experience memory.
            if content == "Use the compatibility tests.":
                assert "Use the public API tests." not in system.text
        else:
            assert len(texts) == 3
            assert "Use the compatibility tests." not in system.text
        assert isinstance(batch[-1], HumanMessage)
        assert batch[-1].content == "Review the scoped change."
    assert instructions.exists() is False


@pytest.mark.asyncio
async def test_snapshot_stays_fixed_during_tool_loop(
    tmp_path: Path, backend: BackendProtocol
) -> None:
    instructions = tmp_path / "AGENTS.md"
    instructions.write_text("Initial guidance.")

    def update_workspace() -> str:
        """Simulate a file changing during the review."""
        instructions.write_text("Changed guidance.")
        return "updated"

    model = RecordingModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[{"name": "update_workspace", "args": {}, "id": "update"}],
            ),
            AIMessage(content="done"),
        ]
    )
    agent = create_agent(
        model=model,
        tools=[update_workspace],
        middleware=[ProjectInstructionsMiddleware(backend=backend)],
    )
    await agent.ainvoke({"messages": [HumanMessage(content="Review.")]})
    assert len(model.batches) == 2
    for batch in model.batches:
        assert "Initial guidance." in batch[0].text
        assert "Changed guidance." not in batch[0].text


@pytest.mark.parametrize(
    "content",
    ["", "<!-- only a comment -->", None],
)
@pytest.mark.asyncio
async def test_missing_or_empty_guidance_does_not_change_prompt(
    tmp_path: Path, backend: BackendProtocol, content: str | None
) -> None:
    if content is not None:
        (tmp_path / "AGENTS.md").write_text(content)
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "AGENTS.md").write_text("Nested instructions.")
    model = RecordingModel(responses=[AIMessage(content="done")])
    agent = create_agent(
        model=model,
        system_prompt="Stage role.",
        middleware=[ProjectInstructionsMiddleware(backend=backend)],
    )
    await agent.ainvoke({"messages": [HumanMessage(content="Review.")]})
    assert model.batches[0][0].text == "Stage role."


@pytest.mark.parametrize(
    "content",
    [
        "x" * (REPOSITORY_INSTRUCTIONS_MAX_CHARS + 1),
        "line\n" * (REPOSITORY_INSTRUCTIONS_MAX_LINES + 1),
    ],
)
@pytest.mark.asyncio
async def test_oversized_guidance_is_omitted_with_notice(
    tmp_path: Path, backend: BackendProtocol, content: str
) -> None:
    """A partial requirement file must not look like complete startup guidance."""
    (tmp_path / "AGENTS.md").write_text(content)
    model = RecordingModel(responses=[AIMessage(content="done")])
    agent = create_agent(
        model=model,
        middleware=[ProjectInstructionsMiddleware(backend=backend)],
    )
    await agent.ainvoke({"messages": [HumanMessage(content="Review.")]})
    system = model.batches[0][0].text
    assert "was not loaded" in system
    assert "startup guidance budget" in system
    assert content not in system


@pytest.mark.parametrize(
    "result",
    [
        ReadResult(error="permission denied"),
        ReadResult(file_data={"content": "AA==", "encoding": "base64"}),
    ],
)
def test_unreadable_guidance_is_not_treated_as_missing(result: ReadResult) -> None:
    backend = Mock(spec=BackendProtocol)
    backend.read.return_value = result
    middleware = ProjectInstructionsMiddleware(backend=backend)
    model = RecordingModel(responses=[AIMessage(content="done")])
    agent = create_agent(
        model=model,
        system_prompt="Stage role.",
        middleware=[middleware],
    )
    agent.invoke({"messages": [HumanMessage(content="Review.")]})
    assert "was not loaded" in model.batches[0][0].text


@pytest.mark.parametrize(
    "role", ["analysis", "mitigation", "verification", "single_agent"]
)
@pytest.mark.asyncio
async def test_review_agents_load_guidance_independently_of_experience_memory(
    monkeypatch, tmp_path: Path, backend: BackendProtocol, role: str
) -> None:
    from importlib import import_module

    module = import_module(f"sec_review_agents.agents.{role}.agent")
    monkeypatch.setattr(module, "create_chat_model", Mock())
    monkeypatch.setattr(module, "create_summarization_middleware", Mock())
    monkeypatch.setattr(module, "agent_skills_enabled", lambda: False)
    build = AsyncMock()
    monkeypatch.setattr(module, "build_agent_runtime_graph", build)
    monkeypatch.setattr(
        module, "invoke_agent_runtime_graph", AsyncMock(return_value={})
    )
    monkeypatch.setenv("AGENT_MCP_ENABLED", "false")
    kwargs = {
        "agent_name": "test",
        "backend": backend,
        "system_prompt": "Stage role.",
        "filesystem_system_prompt": "Tools.",
        "user_prompt": "Review.",
        "memory_enabled": False,
    }
    if role in {"mitigation", "single_agent"}:
        kwargs.update(
            baseline_snapshot_tar_path=tmp_path / "baseline.tar",
            workspace_root_path=tmp_path,
        )
    if role == "single_agent":
        kwargs.update(todo_system_prompt="Todo.", todo_tool_description="Plan.")
    function_name = {
        "analysis": "run_analysis_agent",
        "mitigation": "run_mitigation_agent",
        "verification": "run_verification_agent",
        "single_agent": "run_single_agent",
    }[role]
    await getattr(module, function_name)(**kwargs)
    middleware = build.call_args.kwargs["middleware"]
    assert (
        sum(isinstance(item, ProjectInstructionsMiddleware) for item in middleware) == 1
    )
    assert not any(isinstance(item, MemoryMiddleware) for item in middleware)
