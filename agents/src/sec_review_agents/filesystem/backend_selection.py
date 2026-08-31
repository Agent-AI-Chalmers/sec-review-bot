from sec_review_agents.filesystem.docker_runtime import is_docker_runtime_available
from sec_review_agents.utils.env import env_value


def selected_sandbox_backend_kind() -> str:
    mode = (env_value("AGENT_SANDBOX_BACKEND") or "auto").strip().lower()
    if mode == "docker":
        return "docker"
    if mode == "local":
        return "local"
    if mode == "bwrap":
        # Bubblewrap is Linux/WSL2-only, experimental, and host-policy-sensitive,
        # so it is never chosen by `auto`. Operators must opt into it explicitly.
        return "bwrap"
    if mode == "auto":
        if is_docker_runtime_available(env_value("AGENT_DOCKER_BIN") or "docker"):
            return "docker"
        return "local"
    raise ValueError("AGENT_SANDBOX_BACKEND must be one of: auto, docker, local, bwrap")
