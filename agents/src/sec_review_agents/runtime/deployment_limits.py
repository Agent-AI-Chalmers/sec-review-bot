from sec_review_agents.llm.factory import resolve_chat_deployment


def resolve_bound_deployment_max_input_tokens(
    agent_name: str,
    *,
    deployment_override: str | None = None,
) -> int:
    """Return the max input token limit for an agent's selected deployment."""
    # Callers start from an agent name, but the limit belongs to the selected
    # deployment. An override changes this invocation only.
    deployment = resolve_chat_deployment(
        agent_name=agent_name,
        deployment_override=deployment_override,
    )
    return deployment.max_input_tokens
