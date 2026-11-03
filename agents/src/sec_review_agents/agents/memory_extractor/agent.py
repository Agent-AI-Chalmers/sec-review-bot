"""Agent execution for extracting durable observations from review trajectories."""

from pathlib import Path
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel

from sec_review_agents.agents.memory_extractor.model import MemoryObservationOutput
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
)
from sec_review_agents.agents.memory_extractor.tools import (
    build_trajectory_tools,
)
from sec_review_agents.features import agent_skills_enabled
from sec_review_agents.runtime.agent_runtime_graph import run_agent_runtime_graph
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
    missing_structured_response_max_retries,
)

MEMORY_EXTRACTOR_AGENT_NAME = "memory-extractor"


async def run_memory_extractor_agent(
    *,
    model: BaseChatModel,
    backend: BackendProtocol,
    user_prompt: str,
    source_trajectory_root: Path,
    extractor_trajectory_path: Path | None = None,
) -> MemoryObservationOutput:
    """Read staged review trajectories and optionally record the extractor itself.

    source_trajectory_root supplies evidence to the trajectory tools;
    extractor_trajectory_path receives this invocation's own execution record.
    """
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
    return await run_agent_runtime_graph(
        user_prompt=user_prompt,
        trajectory_paths=(
            (extractor_trajectory_path,)
            if extractor_trajectory_path is not None
            else ()
        ),
        model=model,
        agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
        backend=backend,
        system_prompt=MEMORY_EXTRACTOR_SYSTEM_PROMPT,
        tools=build_trajectory_tools(source_trajectory_root),
        response_format=MemoryObservationOutput,
        middleware=agent_middleware,
    )
