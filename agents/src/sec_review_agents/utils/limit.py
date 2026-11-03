from langgraph.graph.state import CompiledStateGraph

from sec_review_agents.utils.env import int_env

# Graph execution steps per agent invocation, not model calls or workflow steps.
DEFAULT_GRAPH_RECURSION_LIMIT = 100


def count_graph_nodes(agent: CompiledStateGraph) -> int:
    nodes = getattr(agent, "nodes", None)
    if not isinstance(nodes, dict):
        return 0
    return len(nodes)


def compute_graph_recursion_limit(agent: CompiledStateGraph) -> int | None:
    """Resolve an environment budget; None lets the caller apply config/defaults."""
    explicit_limit = int_env("AGENT_GRAPH_RECURSION_LIMIT", None, minimum=1)
    if explicit_limit is not None:
        return explicit_limit

    max_steps = int_env("AGENT_GRAPH_MAX_STEPS", None, minimum=1)
    if max_steps is None:
        return None

    # Approximate rounds by charging one traversal of all compiled nodes per round.
    # Middleware hooks may add nodes; branches need not visit every node, so this
    # is a budget heuristic, not a guarantee of MAX_STEPS model calls or rounds.
    node_count = max(count_graph_nodes(agent), 1)
    buffer_steps = int_env("AGENT_GRAPH_RECURSION_BUFFER", 8, minimum=0)
    return (max_steps * node_count) + buffer_steps
