import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, overload


@dataclass(frozen=True)
class PathView:
    """Path mapping declared before constructing a filesystem backend."""

    # Host paths are real paths on the Python process host. Container and agent
    # paths are Unix-style paths in their respective virtual filesystems.
    host_path: Path | None
    agent_path: str
    # Only Docker path views need a distinct container mount path. A view
    # without one is not a Docker path mapping.
    container_path: str | None = None
    # Controls agent file mutations under this path. Shell execution is a
    # backend capability, not a per-path permission.
    writable: bool = False

    def __post_init__(self) -> None:
        if not self.agent_path.strip():
            raise ValueError("PathView.agent_path must be non-empty.")
        if self.container_path is not None and not self.container_path.strip():
            raise ValueError("PathView.container_path must be non-empty when provided.")


def read_only_path_view(
    *,
    host_path: Path,
    container_path: str | None = None,
    agent_path: str,
) -> PathView:
    """Expose a read-only host path at an agent-visible path.

    By default, the container path is the same Unix path the agent sees, such
    as `/workspace` or `/readonly`. Pass `container_path` only when Docker
    should mount the host path somewhere else inside the container while
    preserving the agent-facing path.
    """

    return PathView(
        host_path=host_path,
        agent_path=agent_path,
        container_path=container_path if container_path is not None else agent_path,
        writable=False,
    )


def workspace_view(
    *,
    host_path: Path,
    container_path: str | None = None,
    writable: bool = False,
) -> PathView:
    """Expose a host path at `/workspace`.

    By default, the container path is also `/workspace`. Pass `container_path`
    only when Docker should mount the workspace elsewhere inside the container
    while preserving `/workspace` as the agent-facing path.
    """

    return PathView(
        host_path=host_path,
        agent_path="/workspace",
        container_path=container_path if container_path is not None else "/workspace",
        writable=writable,
    )


def skill_view(*, host_path: Path) -> PathView:
    return read_only_path_view(host_path=host_path, agent_path="/skills")


def memory_view(*, host_path: Path) -> PathView:
    return read_only_path_view(host_path=host_path, agent_path="/memory")


def writable_memory_view(*, host_path: Path) -> PathView:
    return PathView(
        host_path=host_path,
        container_path="/memory",
        agent_path="/memory",
        writable=True,
    )


def _host_tmp_view() -> PathView:
    """Expose the host temp directory as agent-visible `/tmp`."""

    return PathView(
        host_path=Path(tempfile.gettempdir()),
        agent_path="/tmp",
        writable=True,
    )


def _container_tmp_view() -> PathView:
    """Expose container-native `/tmp` without a host path source."""

    return PathView(
        host_path=None,
        container_path="/tmp",
        agent_path="/tmp",
        writable=True,
    )


@overload
def tmp_view_for_backend(backend_kind: Literal["docker", "local"]) -> PathView: ...


@overload
def tmp_view_for_backend(backend_kind: Literal["bwrap"]) -> None: ...


@overload
def tmp_view_for_backend(backend_kind: str) -> PathView | None: ...


def tmp_view_for_backend(backend_kind: str) -> PathView | None:
    """Return the `/tmp` path view appropriate for a backend kind."""

    normalized_kind = backend_kind.strip().lower()
    if normalized_kind == "docker":
        return _container_tmp_view()
    if normalized_kind == "local":
        return _host_tmp_view()
    if normalized_kind == "bwrap":
        # bwrap commands already get a private tmpfs at /tmp. Do not expose host
        # /tmp as a path view, and do not pretend the per-command tmpfs is a
        # persistent filesystem backend route.
        return None
    raise ValueError("backend_kind must be one of: docker, local, bwrap")
