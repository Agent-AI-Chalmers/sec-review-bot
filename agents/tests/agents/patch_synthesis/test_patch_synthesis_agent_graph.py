from unittest.mock import patch

import pytest
from langchain.agents.structured_output import ToolStrategy

from sec_review_agents.agents.patch_synthesis.agent import (
    EMPTY_REPAIR_CORRECTION,
    run_patch_synthesis_agent,
)
from sec_review_agents.agents.patch_synthesis.model import PatchSynthesisOutput
from sec_review_agents.runtime.committed_patch_middleware import (
    CommittedPatchMiddleware,
)


@pytest.mark.asyncio
async def test_run_patch_synthesis_agent_uses_fixed_response_format(
    tmp_path,
) -> None:
    created_kwargs: dict = {}
    backend = object()
    middleware = object()
    model = object()
    agent = object()

    def _create_agent_side_effect(*args, **kwargs):
        created_kwargs.update(kwargs)
        return agent

    with (
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.invoke_agent_runtime_graph",
            return_value=agent,
        ),
        patch(
            "sec_review_agents.agents.patch_synthesis.agent.model_turn_diagnostics_enabled",
            return_value=False,
        ),
        patch(
            "sec_review_agents.agents.patch_synthesis.agent.create_summarization_middleware",
            return_value=middleware,
        ),
        patch(
            "sec_review_agents.agents.patch_synthesis.agent.create_chat_model",
            return_value=model,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent",
            side_effect=_create_agent_side_effect,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration",
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=None,
        ),
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.tracing_configured",
            return_value=False,
        ),
    ):
        created_agent = await run_patch_synthesis_agent(
            user_prompt="task",
            backend=backend,
            workspace_root_path=tmp_path,
            baseline_commit="baseline",
            workspace_snapshot_tar_path=tmp_path / "baseline.tar",
        )

    assert created_agent is agent
    assert isinstance(created_kwargs["response_format"], ToolStrategy)
    assert created_kwargs["response_format"].schema is PatchSynthesisOutput

    acceptance = [
        item
        for item in created_kwargs["middleware"]
        if isinstance(item, CommittedPatchMiddleware)
    ]
    assert len(acceptance) == 1
    assert acceptance[0].baseline_commit == "baseline"
    assert acceptance[0].workspace_snapshot_tar_path == tmp_path / "baseline.tar"
    assert acceptance[0].empty_repair_correction == EMPTY_REPAIR_CORRECTION
