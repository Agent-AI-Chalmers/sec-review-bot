from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.utils.env import int_env


def count_graph_nodes(agent: CompiledStateGraph) -> int:
    nodes = getattr(agent, "nodes", None)
    if not isinstance(nodes, dict):
        return 0
    return len(nodes)


def compute_graph_recursion_limit(agent: CompiledStateGraph) -> int | None:
    explicit_limit = int_env("AGENT_GRAPH_RECURSION_LIMIT", None, minimum=1)
    if explicit_limit is not None:
        return explicit_limit

    max_steps = int_env("AGENT_GRAPH_MAX_STEPS", None, minimum=1)
    if max_steps is None:
        return None

    node_count = max(count_graph_nodes(agent), 1)
    buffer_steps = int_env("AGENT_GRAPH_RECURSION_BUFFER", 8, minimum=0)
    return (max_steps * node_count) + buffer_steps
