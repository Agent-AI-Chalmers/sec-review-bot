from unittest.mock import patch, sentinel

import pytest

from sec_review_agents.agents.discovery.agent import (
    DISCOVERY_AGENT_NAME,
    create_repository_discovery_agent_graph,
)
from sec_review_agents.agents.discovery.model import DiscoveryOutput


@pytest.mark.asyncio
async def test_create_agent_uses_skills_filesystem_and_diagnostics_middleware() -> None:
    entry = {"chunk_id": "chunk-1", "path": "src/server.js"}

    with (
        patch(
            "sec_review_agents.agents.discovery.agent.SkillsMiddleware",
            return_value=sentinel.skills_middleware,
        ),
        patch(
            "sec_review_agents.agents.discovery.agent.create_filesystem_middleware",
            return_value=sentinel.filesystem_middleware,
        ) as filesystem_middleware_mock,
        patch(
            "sec_review_agents.agents.discovery.agent.ModelTurnDiagnosticsMiddleware",
            return_value=sentinel.diagnostics_middleware,
        ) as diagnostics_mock,
        patch(
            "sec_review_agents.agents.discovery.agent.create_chat_model",
            return_value=sentinel.model,
        ) as model_mock,
        patch(
            "sec_review_agents.agents.discovery.agent.build_repository_discovery_system_prompt",
            return_value="base system prompt",
        ) as base_prompt_mock,
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.create_agent",
            return_value=sentinel.agent,
        ) as create_agent_mock,
        patch(
            "sec_review_agents.agents.discovery.agent.create_summarization_middleware",
            return_value=sentinel.summarization_middleware,
        ),
        patch(
            "sec_review_agents.agents.discovery.agent.PatchToolCallsMiddleware",
            return_value=sentinel.patch_tool_calls_middleware,
        ),
        patch(
            "sec_review_agents.agents.discovery.agent.MissingStructuredResponseMiddleware",
            return_value=sentinel.missing_structured_response_middleware,
        ) as missing_structured_response_mock,
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.log_agent_configuration"
        ) as log_mock,
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.compute_graph_recursion_limit",
            return_value=7,
        ) as recursion_mock,
        patch(
            "sec_review_agents.runtime.agent_runtime_graph.tracing_configured",
            return_value=True,
        ),
    ):
        agent = await create_repository_discovery_agent_graph(
            backend=sentinel.backend,
            chunk=entry,
        )

    assert agent is sentinel.agent
    diagnostics_mock.assert_called_once_with(agent_name=DISCOVERY_AGENT_NAME)
    model_mock.assert_called_once_with(agent_name=DISCOVERY_AGENT_NAME)
    base_prompt_mock.assert_called_once_with()
    recursion_mock.assert_called_once_with(sentinel.agent)
    filesystem_middleware_mock.assert_called_once_with(backend=sentinel.backend)

    create_agent_mock.assert_called_once()
    kwargs = create_agent_mock.call_args.kwargs
    assert kwargs["model"] == sentinel.model
    assert kwargs["tools"] == []
    assert kwargs["middleware"] == [
        sentinel.missing_structured_response_middleware,
        sentinel.skills_middleware,
        sentinel.filesystem_middleware,
        sentinel.summarization_middleware,
        sentinel.patch_tool_calls_middleware,
        sentinel.diagnostics_middleware,
    ]
    assert kwargs["system_prompt"] == "base system prompt"
    assert kwargs["response_format"] is DiscoveryOutput
    assert kwargs["name"] == DISCOVERY_AGENT_NAME
    assert "skills" not in kwargs
    assert "backend" not in kwargs
    missing_structured_response_mock.assert_called_once_with(max_retries=2)

    log_mock.assert_called_once_with(
        agent_name=DISCOVERY_AGENT_NAME,
        agent=agent,
        backend=sentinel.backend,
        middleware=[
            sentinel.missing_structured_response_middleware,
            sentinel.skills_middleware,
            sentinel.filesystem_middleware,
            sentinel.summarization_middleware,
            sentinel.patch_tool_calls_middleware,
            sentinel.diagnostics_middleware,
        ],
        recursion_limit=7,
        tracing_configured=True,
    )
