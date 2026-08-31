from unittest.mock import patch

import pytest

from sec_review_agents.agents.patch_synthesis.agent import (
    create_patch_synthesis_agent_graph,
)
from sec_review_agents.agents.patch_synthesis.model import PatchSynthesisOutput


@pytest.mark.asyncio
async def test_create_patch_synthesis_agent_graph_uses_fixed_response_format(
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
        created_agent = await create_patch_synthesis_agent_graph(
            backend=backend,
            workspace_root_path=tmp_path,
        )

    assert created_agent is agent
    assert created_kwargs["response_format"] is PatchSynthesisOutput
