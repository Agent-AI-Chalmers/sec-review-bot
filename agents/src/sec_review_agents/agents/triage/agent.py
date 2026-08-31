from typing import Any, Literal

from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel, Field, model_validator

from sec_review_agents.agents.triage.backend import (
    create_repository_triage_backend,
)
from sec_review_agents.agents.triage.prompts import (
    TriagePassKind,
    build_repository_triage_system_prompt,
)
from sec_review_agents.agents.triage.workbench_state import TriageWorkbenchState
from sec_review_agents.agents.triage.workbench_tools import (
    build_triage_workbench_tools,
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

REPOSITORY_TRIAGER_AGENT_NAME = "repository-triager"


async def create_repository_triage_agent_graph(
    *,
    backend,
    workbench_state: TriageWorkbenchState | None = None,
    pass_kind: TriagePassKind = "draft",
) -> CompiledStateGraph:
    workbench_state = workbench_state or TriageWorkbenchState.from_candidates([])
    model = create_chat_model(agent_name=REPOSITORY_TRIAGER_AGENT_NAME)
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
            agent_name=REPOSITORY_TRIAGER_AGENT_NAME,
            model=model,
        )
    )
    agent_middleware.append(PatchToolCallsMiddleware())
    if model_turn_diagnostics_enabled():
        agent_middleware.append(
            ModelTurnDiagnosticsMiddleware(agent_name=REPOSITORY_TRIAGER_AGENT_NAME)
        )
    system_prompt = build_repository_triage_system_prompt(pass_kind=pass_kind)
    return await build_agent_runtime_graph(
        model=model,
        agent_name=REPOSITORY_TRIAGER_AGENT_NAME,
        backend=backend,
        system_prompt=system_prompt,
        response_format=_triage_done_model(workbench_state),
        tools=build_triage_workbench_tools(workbench_state),
        middleware=agent_middleware,
    )


def _triage_done_model(workbench_state: TriageWorkbenchState) -> type[BaseModel]:
    class TriagePlanningDone(BaseModel):
        done: Literal[True] = Field(
            default=True,
            description="Set to true only when the triage workbench is complete.",
        )

        @model_validator(mode="after")
        def validate_workbench_state_complete(self) -> TriagePlanningDone:
            constraints = workbench_state.constraints()
            if not constraints.get("ok"):
                raise ValueError(
                    "triage workbench is incomplete; continue editing groups "
                    "until constraints are ok"
                )
            return self

    return TriagePlanningDone


__all__ = [
    "create_repository_triage_agent_graph",
    "create_repository_triage_backend",
]
