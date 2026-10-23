from sec_review_agents.utils.env import env_value


def selected_sandbox_backend_kind() -> str:
    """Choose the sandbox an execution-capable agent runs in.

    `local` is deliberately not a value here. It has no shell, so an agent that
    reviews code cannot run tests, read history, or reproduce a finding. Agents
    that do not need one select `local` for themselves, so no operator setting
    may hand it to a stage that does.
    """
    mode = (env_value("AGENT_SANDBOX_BACKEND") or "docker").strip().lower()
    if mode == "docker":
        return "docker"
    if mode == "bwrap":
        # Bubblewrap is Linux/WSL2-only, experimental, and host-policy-sensitive,
        # so operators must opt into it explicitly.
        return "bwrap"
    raise ValueError("AGENT_SANDBOX_BACKEND must be one of: docker, bwrap")
