from typing import Any

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.cvss.model import CvssV4ScoringOutput
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
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


async def create_cvss_agent_graph(
    *,
    agent_name: str,
    backend: BackendProtocol,
    system_prompt: str,
    filesystem_system_prompt: str,
) -> CompiledStateGraph:
    model = create_chat_model(agent_name=agent_name)
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
        create_filesystem_middleware(
            backend=backend,
            system_prompt=filesystem_system_prompt,
        ),
        create_summarization_middleware(
            agent_name=agent_name,
            model=model,
        ),
        PatchToolCallsMiddleware(),
    ]
    if model_turn_diagnostics_enabled():
        agent_middleware.append(ModelTurnDiagnosticsMiddleware(agent_name=agent_name))

    return await build_agent_runtime_graph(
        model=model,
        agent_name=agent_name,
        backend=backend,
        system_prompt=system_prompt,
        response_format=CvssV4ScoringOutput,
        tools=[],
        middleware=agent_middleware,
    )
