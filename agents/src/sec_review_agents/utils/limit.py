from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.utils.env import env_value, parse_int_env


def _explicit_recursion_limit() -> int | None:
    return parse_int_env(
        env_value("AGENT_GRAPH_RECURSION_LIMIT"),
        None,
    )


def _graph_max_steps() -> int | None:
    return parse_int_env(
        env_value("AGENT_GRAPH_MAX_STEPS"),
        None,
    )


def _graph_buffer_steps() -> int:
    return (
        parse_int_env(
            env_value("AGENT_GRAPH_RECURSION_BUFFER"),
            8,
        )
        or 8
    )


def count_graph_nodes(agent: CompiledStateGraph) -> int:
    nodes = getattr(agent, "nodes", None)
    if not isinstance(nodes, dict):
        return 0
    return len(nodes)


def compute_graph_recursion_limit(agent: CompiledStateGraph) -> int | None:
    explicit_limit = _explicit_recursion_limit()
    if explicit_limit is not None and explicit_limit > 0:
        return explicit_limit

    max_steps = _graph_max_steps()
    if max_steps is None or max_steps <= 0:
        return None

    node_count = max(count_graph_nodes(agent), 1)
    return (max_steps * node_count) + _graph_buffer_steps()
