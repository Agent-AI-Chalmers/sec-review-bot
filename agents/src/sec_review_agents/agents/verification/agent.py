from typing import Any

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.verification.model import VerificationOutput
from sec_review_agents.features import agent_skills_enabled, memory_consumption_enabled
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.memory.runtime_view import memory_runtime_available
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.memory_middleware import (
    SECURITY_REVIEW_MEMORY_SYSTEM_PROMPT,
    MemoryMiddleware,
)
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
    mcp_tools: list[Any],
) -> CompiledStateGraph:
    model = create_chat_model(agent_name=agent_name)
    memory_enabled = memory_consumption_enabled() and memory_runtime_available()
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
    ]
    if agent_skills_enabled():
        agent_middleware.append(SkillsMiddleware(backend=backend, sources=["/skills/"]))
    if memory_enabled:
        agent_middleware.append(
            MemoryMiddleware(
                backend=backend,
                system_prompt_template=SECURITY_REVIEW_MEMORY_SYSTEM_PROMPT,
            )
        )
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

    return await build_agent_runtime_graph(
        model=model,
        agent_name=agent_name,
        backend=backend,
        system_prompt=system_prompt,
        response_format=VerificationOutput,
        tools=mcp_tools,
        middleware=agent_middleware,
    )
