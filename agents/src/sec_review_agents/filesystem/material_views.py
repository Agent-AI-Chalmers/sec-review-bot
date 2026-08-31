import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class MaterialView:
    """Backend-neutral declaration for exposing host/runtime material to agents."""

    # Host paths are real paths on the Python process host. Container and agent
    # paths are Unix-style paths in their respective virtual filesystems.
    host_path: Path | None
    container_path: str
    agent_path: str
    # Controls agent file mutations for this material. Shell execution is a
    # backend capability, not a per-material permission.
    writable: bool = False

    def __post_init__(self) -> None:
        if not self.container_path.strip():
            raise ValueError("MaterialView.container_path must be non-empty.")
        if not self.agent_path.strip():
            raise ValueError("MaterialView.agent_path must be non-empty.")


def read_only_material_view(
    *,
    host_path: Path,
    container_path: str | None = None,
    agent_path: str,
) -> MaterialView:
    """Expose read-only host material at an agent-visible path.

    By default, the container path is the same Unix path the agent sees, such
    as `/workspace` or `/readonly`. Pass `container_path` only when Docker
    should mount the host material somewhere else inside the container while
    preserving the agent-facing path.
    """

    return MaterialView(
        host_path=host_path,
        container_path=container_path if container_path is not None else agent_path,
        agent_path=agent_path,
        writable=False,
    )


def workspace_view(
    *,
    host_path: Path,
    container_path: str | None = None,
    writable: bool = False,
) -> MaterialView:
    """Expose host material at `/workspace`.

    By default, the container path is also `/workspace`. Pass `container_path`
    only when Docker should mount the workspace elsewhere inside the container
    while preserving `/workspace` as the agent-facing path.
    """

    return MaterialView(
        host_path=host_path,
        container_path=container_path if container_path is not None else "/workspace",
        agent_path="/workspace",
        writable=writable,
    )


def skill_view(*, host_path: Path) -> MaterialView:
    return read_only_material_view(host_path=host_path, agent_path="/skills")


def memory_view(*, host_path: Path) -> MaterialView:
    return read_only_material_view(host_path=host_path, agent_path="/memory")


def writable_memory_view(*, host_path: Path) -> MaterialView:
    return MaterialView(
        host_path=host_path,
        container_path="/memory",
        agent_path="/memory",
        writable=True,
    )


def host_tmp_view() -> MaterialView:
    """Expose the host temp directory as agent-visible `/tmp`."""

    return MaterialView(
        host_path=Path(tempfile.gettempdir()),
        container_path="/tmp",
        agent_path="/tmp",
        writable=True,
    )


def container_tmp_view() -> MaterialView:
    """Expose container-native `/tmp` without a host material source."""

    return MaterialView(
        host_path=None,
        container_path="/tmp",
        agent_path="/tmp",
        writable=True,
    )


def tmp_view_for_backend(backend_kind: str) -> MaterialView | None:
    """Return the `/tmp` material view appropriate for a backend kind."""

    normalized_kind = backend_kind.strip().lower()
    if normalized_kind == "docker":
        return container_tmp_view()
    if normalized_kind == "local":
        return host_tmp_view()
    if normalized_kind == "bwrap":
        # bwrap commands already get a private tmpfs at /tmp. Do not expose host
        # /tmp as a material view, and do not pretend the per-command tmpfs is a
        # persistent filesystem backend route.
        return None
    raise ValueError("backend_kind must be one of: docker, local, bwrap")
