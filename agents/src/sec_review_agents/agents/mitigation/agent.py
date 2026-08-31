from pathlib import Path
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.todo import TodoListMiddleware
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.mitigation.mcp import MITIGATION_AGENT_MCP_TOOLS
from sec_review_agents.agents.mitigation.model import MitigationOutput
from sec_review_agents.features import agent_memory_enabled, agent_skills_enabled
from sec_review_agents.llm.factory import create_chat_model
from sec_review_agents.mcp.resolver import resolve_agent_mcp_connection_factories
from sec_review_agents.memory.middleware import MemoryMiddleware
from sec_review_agents.memory.store import memory_runtime_available
from sec_review_agents.runtime.agent_runtime_graph import build_agent_runtime_graph
from sec_review_agents.runtime.changed_files_acceptance_middleware import (
    ChangedFilesAcceptanceMiddleware,
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


async def create_mitigation_agent_graph(
    *,
    agent_name: str,
    backend: BackendProtocol,
    system_prompt: str,
    filesystem_system_prompt: str,
    baseline_snapshot_tar_path: Path,
    workspace_root_path: Path,
) -> CompiledStateGraph:
    model = create_chat_model(agent_name=agent_name)
    memory_enabled = agent_memory_enabled() and memory_runtime_available()
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
        ChangedFilesAcceptanceMiddleware(
            worktree_path=workspace_root_path,
            baseline_snapshot_tar_path=baseline_snapshot_tar_path,
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
    agent_middleware.append(TodoListMiddleware())
    if model_turn_diagnostics_enabled():
        agent_middleware.append(ModelTurnDiagnosticsMiddleware(agent_name=agent_name))

    mcp_connections: dict[str, Any] = {}
    for connection_factory in resolve_agent_mcp_connection_factories(
        MITIGATION_AGENT_MCP_TOOLS,
        backend,
    ):
        mcp_connections.update(connection_factory())
    return await build_agent_runtime_graph(
        model=model,
        agent_name=agent_name,
        backend=backend,
        system_prompt=system_prompt,
        response_format=MitigationOutput,
        mcp_connections=mcp_connections,
        middleware=agent_middleware,
    )
