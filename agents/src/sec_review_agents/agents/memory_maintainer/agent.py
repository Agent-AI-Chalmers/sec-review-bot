from pathlib import Path

from deepagents.backends.protocol import BackendProtocol
from langchain_core.language_models import BaseChatModel
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.memory_maintainer.model import MemoryMaintenanceOutput
from sec_review_agents.agents.memory_maintainer.prompts import (
    MEMORY_MAINTAINER_SYSTEM_PROMPT,
)
from sec_review_agents.agents.memory_maintainer.tools import (
    build_memory_delete_file_tool,
)
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.filesystem_middleware import create_filesystem_middleware
from sec_review_agents.runtime.structured_response_middleware import (
    MissingStructuredResponseMiddleware,
    missing_structured_response_max_retries,
)

MEMORY_MAINTAINER_AGENT_NAME = "memory-maintainer"


async def create_memory_maintainer_agent_graph(
    *,
    model: BaseChatModel,
    backend: BackendProtocol,
    worktree_root: Path,
) -> CompiledStateGraph:
    return await build_agent_runtime_graph(
        model=model,
        agent_name=MEMORY_MAINTAINER_AGENT_NAME,
        backend=backend,
        system_prompt=MEMORY_MAINTAINER_SYSTEM_PROMPT,
        tools=[build_memory_delete_file_tool(worktree_root)],
        response_format=MemoryMaintenanceOutput,
        middleware=[
            MissingStructuredResponseMiddleware(
                max_retries=missing_structured_response_max_retries(),
            ),
            create_filesystem_middleware(
                backend=backend,
            ),
        ],
    )
