from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import merge_configs
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel

from sec_review_agents.observability.diagnostics import (
    log_agent_configuration,
    log_agent_invocation_failed,
    log_agent_invocation_started,
    log_agent_invocation_succeeded,
)
from sec_review_agents.observability.tracing import (
    build_tracing_config,
    tracing_configured,
)
from sec_review_agents.runtime.trajectories import TrajectoryWriter
from sec_review_agents.utils.limit import compute_graph_recursion_limit


async def run_agent_runtime_graph[T: BaseModel](
    *,
    agent_name: str,
    model: BaseChatModel,
    backend: BackendProtocol | None,
    system_prompt: str,
    response_format: type[T],
    user_prompt: str,
    tools: list[Any] | None = None,
    middleware: Sequence[AgentMiddleware[Any, Any, Any]] | None = None,
    trajectory_paths: tuple[Path, ...] = (),
    config: RunnableConfig | None = None,
) -> T:
    """Build and invoke a graph with one shared output type, name, and prompt.

    response_format must be a Pydantic model class.
    The caller must keep tool resources alive for the duration of this call.
    """
    agent = await build_agent_runtime_graph(
        agent_name=agent_name,
        model=model,
        backend=backend,
        system_prompt=system_prompt,
        response_format=response_format,
        tools=tools,
        middleware=middleware,
    )
    return await invoke_agent_runtime_graph(
        agent=agent,
        response_format=response_format,
        agent_name=agent_name,
        user_prompt=user_prompt,
        trajectory_paths=trajectory_paths,
        config=config,
    )


async def build_agent_runtime_graph(
    *,
    agent_name: str,
    model: BaseChatModel,
    backend: BackendProtocol | None,
    system_prompt: str,
    response_format: Any | None = None,
    tools: list[Any] | None = None,
    middleware: Sequence[AgentMiddleware[Any, Any, Any]] | None = None,
) -> CompiledStateGraph:
    """Build a graph without taking ownership of tool resources.

    Keep resources used by the supplied tools alive while executing the graph.
    """
    agent_middleware = middleware or ()

    agent = create_agent(
        model=model,
        middleware=agent_middleware,
        system_prompt=system_prompt,
        name=agent_name,
        response_format=response_format,
        tools=list(tools or []),
    )
    log_agent_configuration(
        agent_name=agent_name,
        agent=agent,
        backend=backend,
        middleware=agent_middleware,
        recursion_limit=compute_graph_recursion_limit(agent),
        tracing_configured=tracing_configured(),
    )
    return agent


async def invoke_agent_runtime_graph[T: BaseModel](
    *,
    agent: CompiledStateGraph,
    response_format: type[T],
    agent_name: str,
    user_prompt: str,
    trajectory_paths: tuple[Path, ...] = (),
    config: RunnableConfig | None = None,
) -> T:
    """Return the graph's validated model instance without serializing it.

    response_format is the Pydantic model class already configured on the graph;
    it checks the result without changing the graph's output schema. Callers
    that require dictionaries serialize the model at their own boundary.
    """

    recursion_limit = compute_graph_recursion_limit(agent)
    tracing_config = build_tracing_config(
        agent_name=agent_name,
    )
    trajectory_writer = (
        TrajectoryWriter(trajectory_paths, agent=agent_name)
        if trajectory_paths
        else None
    )

    invoke_config = merge_configs(
        config,
        tracing_config.to_langchain_config(),
    )
    if recursion_limit is not None:
        invoke_config["recursion_limit"] = recursion_limit

    started_at = log_agent_invocation_started(
        agent_name=agent_name,
        recursion_limit=recursion_limit,
        tracing_enabled=tracing_config.enabled,
    )
    user_message = HumanMessage(content=user_prompt)
    if trajectory_writer is not None:
        trajectory_writer.defer_messages([user_message], agent=agent_name)

    async def invoke_agent() -> Any:
        structured_result: Any | None = None
        # Execution events include model calls absent from parent state updates.
        async for event in agent.astream_events(
            {"messages": [user_message]},
            config=invoke_config,
            version="v2",
            stream_mode="updates",
        ):
            if trajectory_writer is not None:
                trajectory_writer.write_execution_event(event)
            # Child outputs must not replace the root conversation or structured result.
            if event["event"] != "on_chain_stream" or event.get("parent_ids"):
                continue
            update = event["data"].get("chunk")
            if not isinstance(update, Mapping):
                continue
            for node_update in update.values():
                if not isinstance(node_update, Mapping):
                    continue
                if trajectory_writer is not None:
                    update_messages = node_update.get("messages")
                    if isinstance(update_messages, list):
                        trajectory_writer.defer_messages(
                            update_messages,
                            run_id=event.get("run_id"),
                            parent_ids=event.get("parent_ids", []),
                            agent=agent_name,
                        )
                candidate = node_update.get("structured_response")
                if candidate is not None:
                    structured_result = candidate
        return structured_result

    status = "interrupted"
    if trajectory_writer is not None:
        trajectory_writer.write_event("model_calls_start")
    try:
        structured_result = await invoke_agent()
        if structured_result is None:
            raise RuntimeError("Agent completed without structured_response.")

        if not isinstance(structured_result, response_format):
            raise TypeError(
                f"Expected {response_format.__name__} structured response, "
                f"got {type(structured_result).__name__}."
            )
        log_agent_invocation_succeeded(
            agent_name=agent_name,
            started_at=started_at,
            structured_response=structured_result,
        )
        status = "completed"
        return structured_result
    except Exception as error:
        status = "failed"
        log_agent_invocation_failed(
            agent_name=agent_name,
            started_at=started_at,
            error=error,
        )
        raise
    finally:
        # A missing terminal marker after SIGKILL/crash is deliberately incomplete.
        if trajectory_writer is not None:
            trajectory_writer.flush_pending_messages()
            trajectory_writer.write_event("model_calls_end", status=status)
        tracing_config.flush()
