from deepagents.backends.protocol import BackendProtocol
from langchain_core.language_models import BaseChatModel
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.memory_extractor.model import MemoryObservationOutput
from sec_review_agents.agents.memory_extractor.prompts import (
    MEMORY_EXTRACTOR_SYSTEM_PROMPT,
)
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
    return await build_agent_runtime_graph(
        model=model,
        agent_name=MEMORY_EXTRACTOR_AGENT_NAME,
        backend=backend,
        system_prompt=MEMORY_EXTRACTOR_SYSTEM_PROMPT,
        response_format=MemoryObservationOutput,
        middleware=[
            MissingStructuredResponseMiddleware(
                max_retries=missing_structured_response_max_retries(),
            ),
            create_filesystem_middleware(
                backend=backend,
            ),
        ],
    )
