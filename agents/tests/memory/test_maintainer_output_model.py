from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest
from langchain_core.messages import BaseMessage
from pydantic import BaseModel, ValidationError

from sec_review_agents.agents.memory_maintainer import agent as maintainer_agent
from sec_review_agents.agents.memory_maintainer.model import (
    memory_maintenance_output_model,
)


def _decision(
    observation_id: str, action: str = "skipped", topics: tuple[str, ...] = ()
) -> dict[str, object]:
    return {
        "observation_id": observation_id,
        "action": action,
        "topics": list(topics),
        "reason": "Already covered by existing guidance.",
    }


def test_accepts_one_decision_per_selected_observation() -> None:
    output_model = memory_maintenance_output_model(["a", "b"])

    output = output_model.model_validate(
        {
            "observation_decisions": [
                _decision("b", "added", ("/memory/topics/t.md",)),
                _decision("a"),
            ],
            "summary": "Added one topic.",
        }
    )

    assert [d.observation_id for d in output.observation_decisions] == ["b", "a"]


@pytest.mark.parametrize(
    ("ids", "problem"),
    [
        (["a"], "missing: b"),
        (["a", "a", "b"], "duplicate: a"),
        (["a", "b", "c"], "unknown: c"),
    ],
)
def test_rejects_decisions_that_do_not_match_selected_observations(
    ids: list[str], problem: str
) -> None:
    """The error text is returned to the model for retry, so it must name the ids."""
    output_model = memory_maintenance_output_model(["a", "b"])

    with pytest.raises(ValidationError, match=problem):
        output_model.model_validate(
            {
                "observation_decisions": [_decision(item) for item in ids],
                "summary": "Reviewed observations.",
            }
        )


def test_reorganization_accepts_no_decisions_and_rejects_invented_ones() -> None:
    output_model = memory_maintenance_output_model([])

    assert output_model.model_validate(
        {"observation_decisions": [], "summary": "No change."}
    )
    with pytest.raises(ValidationError, match="unknown: a"):
        output_model.model_validate(
            {"observation_decisions": [_decision("a")], "summary": "No change."}
        )


@pytest.mark.parametrize("action", ["added", "merged", "conflict"])
def test_edit_decisions_must_name_topics(action: str) -> None:
    output_model = memory_maintenance_output_model(["a"])

    with pytest.raises(ValidationError, match="must name the edited topics"):
        output_model.model_validate(
            {"observation_decisions": [_decision("a", action)], "summary": "x"}
        )


def test_run_schema_keeps_public_name_and_guidance() -> None:
    """The model sees the class name and docstring through the response schema."""
    schema = memory_maintenance_output_model(["a"]).model_json_schema()

    assert schema["title"] == "MemoryMaintenanceOutput"
    assert schema["description"]
    assert schema["$defs"]["ObservationDecision"]["description"]


@pytest.mark.asyncio
async def test_maintainer_uses_retryable_tool_strategy(tmp_path: Path) -> None:
    """ProviderStrategy raises on validator errors; ToolStrategy returns them for retry."""
    with (
        patch.object(maintainer_agent, "create_filesystem_middleware"),
        patch.object(
            maintainer_agent, "build_agent_runtime_graph", AsyncMock()
        ) as build,
        patch.object(maintainer_agent, "invoke_agent_runtime_graph", AsyncMock()),
    ):
        await maintainer_agent.run_memory_maintainer_agent(
            model=Mock(),
            backend=Mock(),
            worktree_root=tmp_path,
            user_prompt="task",
            observation_ids=["a"],
        )

    assert build.await_args is not None
    response_format = build.await_args.kwargs["response_format"]
    schema = response_format
    assert isinstance(schema, type) and issubclass(schema, BaseModel)
    with pytest.raises(ValidationError, match="missing: a"):
        schema.model_validate({"observation_decisions": [], "summary": "No change."})


@pytest.mark.asyncio
@pytest.mark.parametrize("failures", [1, 3, 4])
async def test_maintainer_validation_retry_budget(
    tmp_path: Path, failures: int
) -> None:
    """Real graph feedback must stop after three retries, independently per run."""
    from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
    from tests.runtime.fake_chat_models import (
        ToolCallingFakeMessagesListChatModel,
        structured_tool_call_message,
    )

    schema = memory_maintenance_output_model(["a"])
    invalid = {"observation_decisions": [], "summary": "Incomplete."}
    valid = {"observation_decisions": [_decision("a")], "summary": "Done."}

    async def build_graph(**kwargs):
        return await build_agent_runtime_graph(
            agent_name="memory-maintainer",
            model=kwargs["model"],
            backend=None,
            system_prompt="Maintain memory",
            tools=[],
            response_format=kwargs["response_format"],
        )

    async def invoke_graph(**kwargs):
        result = await kwargs["agent"].ainvoke(
            {"messages": [{"role": "user", "content": "Maintain"}]}
        )
        feedback = [
            m
            for m in result["messages"]
            if m.type == "tool" and "missing: a" in m.content
        ]
        assert len(feedback) == failures
        return result["structured_response"]

    with (
        patch.object(maintainer_agent, "create_filesystem_middleware"),
        patch.object(maintainer_agent, "build_agent_runtime_graph", build_graph),
        patch.object(maintainer_agent, "invoke_agent_runtime_graph", invoke_graph),
    ):
        for _ in range(2):
            responses: list[BaseMessage] = [
                structured_tool_call_message(schema, invalid, call_id=f"bad-{i}")
                for i in range(failures)
            ]
            responses.append(
                structured_tool_call_message(schema, valid, call_id="good")
            )
            model = ToolCallingFakeMessagesListChatModel(responses=responses)
            invocation = maintainer_agent.run_memory_maintainer_agent(
                model=model,
                backend=Mock(),
                worktree_root=tmp_path,
                user_prompt="task",
                observation_ids=["a"],
            )
            if failures > 3:
                with pytest.raises(RuntimeError, match="after 3 correction retries"):
                    await invocation
                assert model.i == 4
            else:
                assert (await invocation).observation_decisions[0].observation_id == "a"
