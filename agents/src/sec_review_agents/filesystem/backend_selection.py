from sec_review_agents.filesystem.docker_runtime import is_docker_runtime_available
from sec_review_agents.utils.env import env_value


def selected_sandbox_backend_kind() -> str:
    """Choose the sandbox an execution-capable agent runs in.

    `local` is deliberately not a value here. It has no shell, so an agent that
    reviews code cannot run tests, read history, or reproduce a finding. Agents
    that do not need one select `local` for themselves, so no operator setting
    may hand it to a stage that does.
    """
    mode = (env_value("AGENT_SANDBOX_BACKEND") or "auto").strip().lower()
    if mode == "docker":
        return "docker"
    if mode == "bwrap":
        # Bubblewrap is Linux/WSL2-only, experimental, and host-policy-sensitive,
        # so it is never chosen by `auto`. Operators must opt into it explicitly.
        return "bwrap"
    if mode == "auto":
        if is_docker_runtime_available(env_value("AGENT_DOCKER_BIN") or "docker"):
            return "docker"
        raise ValueError(
            "AGENT_SANDBOX_BACKEND=auto found no usable sandbox: the Docker "
            "runtime is not available. Execution-capable agents need a sandbox "
            "that can run commands. Start Docker, or set "
            "AGENT_SANDBOX_BACKEND=bwrap on a host that supports it."
        )
    raise ValueError("AGENT_SANDBOX_BACKEND must be one of: auto, docker, bwrap")
