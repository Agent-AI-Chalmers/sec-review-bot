from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import merge_configs
from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.mcp.client import load_mcp_tools_async
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
from sec_review_agents.runtime.transcripts import TranscriptWriter
from sec_review_agents.utils.limit import compute_graph_recursion_limit


async def build_agent_runtime_graph(
    *,
    agent_name: str,
    model: BaseChatModel,
    backend: BackendProtocol | None,
    system_prompt: str,
    response_format: Any | None = None,
    tools: list[Any] | None = None,
    mcp_connections: Mapping[str, Any] | None = None,
    middleware: Sequence[AgentMiddleware[Any, Any, Any]] | None = None,
) -> CompiledStateGraph:
    agent_middleware = middleware or ()
    # This is the lowest-level agent runtime graph: model, middleware, tools,
    # MCP, and structured output. Stage graphs compose around it.
    # Keep MCP loading here so callers pass connections, not already-materialized
    # tools. That avoids sync wrappers around MCP setup and keeps normal tools
    # and MCP tools ordered in one place.
    mcp_tools = await load_mcp_tools_async(mcp_connections)
    agent_tools = [*(tools or []), *mcp_tools]

    agent = create_agent(
        model=model,
        middleware=agent_middleware,
        system_prompt=system_prompt,
        name=agent_name,
        response_format=response_format,
        tools=agent_tools,
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


async def invoke_agent_runtime_graph(
    *,
    agent: CompiledStateGraph,
    agent_name: str,
    system_prompt: str,
    user_prompt: str,
    transcript_paths: tuple[Path, ...] = (),
    config: RunnableConfig | None = None,
) -> dict:
    """Run a configured LangGraph agent and return its structured payload."""

    recursion_limit = compute_graph_recursion_limit(agent)
    tracing_config = build_tracing_config(
        agent_name=agent_name,
    )
    transcript_writer = (
        TranscriptWriter(transcript_paths, agent_name=agent_name)
        if transcript_paths
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
    if transcript_writer is not None:
        transcript_writer.write_system_prompt(system_prompt)

    messages: list[Any] = [
        {
            "role": "user",
            "content": user_prompt,
        }
    ]

    async def invoke_agent() -> dict:
        agent_result = await agent.ainvoke(
            {"messages": messages},
            config=invoke_config,
        )

        if transcript_writer is not None:
            transcript_writer.write_messages(
                agent_result.get("messages") if isinstance(agent_result, dict) else None
            )

        return agent_result if isinstance(agent_result, dict) else {}

    try:
        agent_result_mapping = await invoke_agent()
        structured_result = agent_result_mapping.get("structured_response")
        if structured_result is None:
            raise RuntimeError("Agent completed without structured_response.")

        log_agent_invocation_succeeded(
            agent_name=agent_name,
            started_at=started_at,
            structured_response=structured_result,
        )

        if hasattr(structured_result, "model_dump"):
            structured_payload = structured_result.model_dump(by_alias=True)
        elif isinstance(structured_result, Mapping):
            structured_payload = dict(structured_result)
        else:
            structured_payload = dict(structured_result)
        return structured_payload
    except Exception as error:
        log_agent_invocation_failed(
            agent_name=agent_name,
            started_at=started_at,
            error=error,
        )
        raise
    finally:
        tracing_config.flush()
