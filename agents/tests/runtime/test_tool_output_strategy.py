import pytest
from langchain_core.messages import AIMessage, BaseMessage

from sec_review_agents.agents.delivery_planning.agent import (
    _delivery_planning_done_model,
)
from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.agents.delivery_planning.workbench_tools import (
    build_delivery_workbench_tools,
)
from sec_review_agents.agents.discovery.model import DiscoveryCandidate
from sec_review_agents.agents.triage.agent import _triage_done_model
from sec_review_agents.agents.triage.workbench_state import TriageWorkbenchState
from sec_review_agents.agents.triage.workbench_tools import build_triage_workbench_tools
from sec_review_agents.runtime.agent_runtime_graph import run_agent_runtime_graph
from sec_review_agents.runtime.tool_output_strategy import (
    tool_strategy_with_retry_limit,
)
from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult
from tests.runtime.fake_chat_models import (
    RecordingToolCallingFakeMessagesListChatModel,
    structured_tool_call_message,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["triage", "delivery"])
@pytest.mark.parametrize("repair", [True, False])
async def test_workbench_completion_correction(kind: str, repair: bool) -> None:
    """The same done=true is accepted only after a real workbench edit."""
    state: TriageWorkbenchState | DeliveryWorkbenchState
    if kind == "triage":
        state = TriageWorkbenchState.from_candidates(
            [
                DiscoveryCandidateResult(
                    candidate_id="a",
                    grounding_status="grounded",
                    candidate=DiscoveryCandidate(
                        category="test", description="Test", locations=[], evidence=[]
                    ),
                )
            ]
        )
        schema = _triage_done_model(state)
        tools = build_triage_workbench_tools(state)
        args = {"kind": "suppress", "item_ids": ["a"], "reason": "Duplicate"}
    else:
        state = DeliveryWorkbenchState.initial(["a"])
        schema = _delivery_planning_done_model(state)
        tools = build_delivery_workbench_tools(state)
        args = {"item_ids": ["a"]}
    responses: list[BaseMessage] = [
        structured_tool_call_message(schema, {"done": True}, call_id="early")
    ]
    if repair:
        responses.extend(
            [
                AIMessage(
                    content="",
                    tool_calls=[{"name": "create_group", "args": args, "id": "edit"}],
                ),
                structured_tool_call_message(
                    schema, {"done": True}, call_id="finished"
                ),
            ]
        )
    else:
        responses.extend(
            structured_tool_call_message(schema, {"done": True}, call_id=f"retry-{i}")
            for i in range(3)
        )
    model = RecordingToolCallingFakeMessagesListChatModel(responses=responses)
    invocation = run_agent_runtime_graph(
        agent_name=kind,
        model=model,
        backend=None,
        system_prompt="Complete the workbench.",
        response_format=schema,
        user_prompt="Complete",
        tools=tools,
    )
    if repair:
        assert (await invocation).model_dump() == {"done": True}
        assert state.constraints()["ok"] is True
        assert len(model.message_batches) == 3
        assert any(
            m.type == "tool" and "incomplete" in m.content
            for m in model.message_batches[1]
        )
    else:
        with pytest.raises(RuntimeError, match="after 3 correction retries") as error:
            await invocation
        assert error.value.__cause__ is not None
        assert len(model.message_batches) == 4
        assert state.constraints()["ok"] is False


def test_negative_retry_budget_is_rejected() -> None:
    with pytest.raises(ValueError, match="non-negative"):
        tool_strategy_with_retry_limit(
            _delivery_planning_done_model(DeliveryWorkbenchState.initial([])),
            max_retries=-1,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [0, 1, 3])
async def test_graph_builder_uses_environment_correction_budget(
    monkeypatch, budget: int
) -> None:
    """Direct graph construction must use the same policy as the run helper."""
    from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph

    monkeypatch.setenv("AGENT_STRUCTURED_OUTPUT_VALIDATION_MAX_RETRIES", str(budget))
    schema = _delivery_planning_done_model(DeliveryWorkbenchState.initial(["a"]))
    model = RecordingToolCallingFakeMessagesListChatModel(
        responses=[
            structured_tool_call_message(schema, {"done": True}, call_id=f"attempt-{i}")
            for i in range(budget + 1)
        ]
    )
    graph = await build_agent_runtime_graph(
        agent_name="budget-probe",
        model=model,
        backend=None,
        system_prompt="Complete",
        response_format=schema,
    )
    with pytest.raises(RuntimeError, match=f"after {budget} correction retries"):
        await graph.ainvoke({"messages": [{"role": "user", "content": "Complete"}]})
    assert len(model.message_batches) == budget + 1
