from typing import Any

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.verification.mcp import (
    VERIFICATION_AGENT_MCP_TOOLS,
)
from sec_review_agents.agents.verification.model import VerificationOutput
from sec_review_agents.features import agent_memory_enabled, agent_skills_enabled
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.mcp.resolver import resolve_agent_mcp_connection_factories
from sec_review_agents.memory.middleware import MemoryMiddleware
from sec_review_agents.memory.store import memory_runtime_available
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


async def create_verification_agent_graph(
    *,
    agent_name: str,
    backend: BackendProtocol,
    system_prompt: str,
    filesystem_system_prompt: str,
) -> CompiledStateGraph:
    model = create_chat_model(agent_name=agent_name)
    memory_enabled = agent_memory_enabled() and memory_runtime_available()
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
    ]
    if agent_skills_enabled():
        agent_middleware.append(SkillsMiddleware(backend=backend, sources=["/skills/"]))
    if memory_enabled:
        agent_middleware.append(MemoryMiddleware(backend=backend))
    agent_middleware.append(
        create_filesystem_middleware(
            backend=backend,
            system_prompt=filesystem_system_prompt,
        )
    )
    agent_middleware.append(
        create_summarization_middleware(
            agent_name=agent_name,
            model=model,
        )
    )
    agent_middleware.append(PatchToolCallsMiddleware())
    if model_turn_diagnostics_enabled():
        agent_middleware.append(ModelTurnDiagnosticsMiddleware(agent_name=agent_name))

    mcp_connections: dict[str, Any] = {}
    for connection_factory in resolve_agent_mcp_connection_factories(
        VERIFICATION_AGENT_MCP_TOOLS,
        backend,
    ):
        mcp_connections.update(connection_factory())
    return await build_agent_runtime_graph(
        model=model,
        agent_name=agent_name,
        backend=backend,
        system_prompt=system_prompt,
        response_format=VerificationOutput,
        mcp_connections=mcp_connections,
        middleware=agent_middleware,
    )
