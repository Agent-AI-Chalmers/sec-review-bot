from typing import Any, Literal

from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from langchain.agents.middleware import AgentMiddleware
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel, Field, model_validator

from sec_review_agents.agents.delivery_planning.prompts import (
    build_repository_delivery_planning_filesystem_system_prompt,
)
from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.agents.delivery_planning.workbench_tools import (
    build_delivery_workbench_tools,
)
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

DELIVERY_PLANNING_AGENT_NAME = "repository-delivery-planner"


async def create_delivery_planning_agent_graph(
    *,
    backend,
    workbench_state: DeliveryWorkbenchState,
    system_prompt: str,
) -> CompiledStateGraph:
    filesystem_system_prompt = (
        build_repository_delivery_planning_filesystem_system_prompt()
    )
    model = create_chat_model(agent_name=DELIVERY_PLANNING_AGENT_NAME)
    agent_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        MissingStructuredResponseMiddleware(
            max_retries=missing_structured_response_max_retries(),
        ),
        create_filesystem_middleware(
            backend=backend,
            system_prompt=filesystem_system_prompt,
        ),
        create_summarization_middleware(
            agent_name=DELIVERY_PLANNING_AGENT_NAME,
            model=model,
        ),
        PatchToolCallsMiddleware(),
    ]
    if model_turn_diagnostics_enabled():
        agent_middleware.append(
            ModelTurnDiagnosticsMiddleware(agent_name=DELIVERY_PLANNING_AGENT_NAME)
        )

    return await build_agent_runtime_graph(
        model=model,
        agent_name=DELIVERY_PLANNING_AGENT_NAME,
        backend=backend,
        system_prompt=system_prompt,
        response_format=_delivery_planning_done_model(workbench_state),
        tools=build_delivery_workbench_tools(workbench_state),
        middleware=agent_middleware,
    )


# Build the completion schema per run so its validator can close over this
# run's workbench state without using module-level mutable state.
def _delivery_planning_done_model(
    workbench_state: DeliveryWorkbenchState,
) -> type[BaseModel]:
    class DeliveryPlanningDone(BaseModel):
        done: Literal[True] = Field(
            default=True,
            description="Set to true only when the delivery workbench state is complete.",
        )

        @model_validator(mode="after")
        def validate_workbench_state_complete(self) -> DeliveryPlanningDone:
            constraints = workbench_state.constraints()
            if not constraints.get("ok"):
                raise ValueError(
                    "delivery workbench state is incomplete; continue editing groups "
                    "until constraints are ok"
                )
            return self

    return DeliveryPlanningDone
