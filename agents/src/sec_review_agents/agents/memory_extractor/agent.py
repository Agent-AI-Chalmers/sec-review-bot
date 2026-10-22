"""Agent graph for extracting durable observations from review transcripts."""

from typing import Any

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.memory_extractor.model import MemoryObservationOutput
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
)
from sec_review_agents.agents.memory_extractor.tools import (
    build_transcript_tools,
)
from sec_review_agents.features import agent_skills_enabled
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
    missing_structured_response_max_retries,
)

MEMORY_EXTRACTOR_AGENT_NAME = "memory-extractor"


async def create_memory_extractor_agent_graph(
    *,
    model: BaseChatModel,
    backend: BackendProtocol,
) -> CompiledStateGraph:
    """Create the structured-output extractor with filesystem and skill access."""
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        )
    ]
    if agent_skills_enabled():
        # The backend exposes all bundled skills at this path. The middleware
        # supplies their catalog and read-on-demand instructions to the model.
        agent_middleware.append(SkillsMiddleware(backend=backend, sources=["/skills/"]))
    agent_middleware.append(create_filesystem_middleware(backend=backend))
    return await build_agent_runtime_graph(
        model=model,
        agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
        backend=backend,
        system_prompt=MEMORY_EXTRACTOR_SYSTEM_PROMPT,
        tools=build_transcript_tools(backend),
        response_format=MemoryObservationOutput,
        middleware=agent_middleware,
    )
