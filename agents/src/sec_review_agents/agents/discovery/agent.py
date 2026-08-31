from collections.abc import Mapping
from typing import Any

from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.discovery.model import DiscoveryOutput
from sec_review_agents.agents.discovery.prompts import (
    build_repository_discovery_system_prompt,
)
from sec_review_agents.features import agent_skills_enabled
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.runtime.agent_runtime_graph import (
    build_agent_runtime_graph,
)
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.model_turn_diagnostics import (
    ModelTurnDiagnosticsMiddleware,
    model_turn_diagnostics_enabled,
)
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
    missing_structured_response_max_retries,
)
from sec_review_agents.runtime.summarization_middleware import (
    create_summarization_middleware,
)

DISCOVERY_AGENT_NAME = "repository-discovery"


async def create_repository_discovery_agent_graph(
    *,
    backend,
    chunk: Mapping[str, Any],
    system_prompt: str | None = None,
) -> CompiledStateGraph:
    chunk_id = str((chunk or {}).get("chunk_id") or "").strip()
    if not chunk_id:
        raise ValueError("Discovery agent graph requires chunk.chunk_id.")

    model = create_chat_model(agent_name=DISCOVERY_AGENT_NAME)
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
    ]
    if agent_skills_enabled():
        agent_middleware.append(SkillsMiddleware(backend=backend, sources=["/skills/"]))
    agent_middleware.append(create_filesystem_middleware(backend=backend))
    agent_middleware.append(
        create_summarization_middleware(
            agent_name=DISCOVERY_AGENT_NAME,
            model=model,
        )
    )
    agent_middleware.append(PatchToolCallsMiddleware())
    if model_turn_diagnostics_enabled():
        agent_middleware.append(
            ModelTurnDiagnosticsMiddleware(agent_name=DISCOVERY_AGENT_NAME)
        )
    system_prompt = system_prompt or build_repository_discovery_system_prompt()

    return await build_agent_runtime_graph(
        model=model,
        agent_name=DISCOVERY_AGENT_NAME,
        backend=backend,
        system_prompt=system_prompt,
        response_format=DiscoveryOutput,
        tools=[],
        middleware=agent_middleware,
    )
