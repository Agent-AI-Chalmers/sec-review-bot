from pathlib import Path
from typing import Any

from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.agents.patch_synthesis.model import PatchSynthesisOutput
from sec_review_agents.agents.patch_synthesis.prompts import (
    build_patch_synthesis_filesystem_system_prompt,
    build_patch_synthesis_system_prompt,
)
from sec_review_agents.llm.factory import create_chat_model
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

PATCH_SYNTHESIS_AGENT_NAME = "patch-synthesizer"


async def create_patch_synthesis_agent_graph(
    *,
    backend,
    workspace_root_path: Path,
    baseline_snapshot_tar_path: Path | None = None,
    system_prompt: str | None = None,
) -> CompiledStateGraph:
    if system_prompt is None:
        system_prompt = build_patch_synthesis_system_prompt()
    filesystem_system_prompt = build_patch_synthesis_filesystem_system_prompt()
    model = create_chat_model(agent_name=PATCH_SYNTHESIS_AGENT_NAME)
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
    ]
    if baseline_snapshot_tar_path is not None:
        agent_middleware.append(
            ChangedFilesAcceptanceMiddleware(
                worktree_path=workspace_root_path,
                baseline_snapshot_tar_path=baseline_snapshot_tar_path,
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
            agent_name=PATCH_SYNTHESIS_AGENT_NAME,
            model=model,
        )
    )
    agent_middleware.append(PatchToolCallsMiddleware())
    if model_turn_diagnostics_enabled():
        agent_middleware.append(
            ModelTurnDiagnosticsMiddleware(agent_name=PATCH_SYNTHESIS_AGENT_NAME)
        )

    return await build_agent_runtime_graph(
        model=model,
        agent_name=PATCH_SYNTHESIS_AGENT_NAME,
        backend=backend,
        system_prompt=system_prompt,
        response_format=PatchSynthesisOutput,
        tools=[],
        middleware=agent_middleware,
    )
