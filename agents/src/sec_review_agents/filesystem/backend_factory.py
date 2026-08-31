import posixpath

from deepagents.backends import CompositeBackend, StateBackend
from deepagents.backends.protocol import BackendProtocol

from sec_review_agents.filesystem import backend_selection
from sec_review_agents.filesystem.bwrap_backend import (
    BwrapRoute,
    BwrapSandboxBackend,
)
from sec_review_agents.filesystem.docker_backend import (
    DockerRoute,
    DockerSandboxBackend,
)
from sec_review_agents.filesystem.docker_runtime import (
    DockerMount,
    create_docker_container_resource,
)
from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend
from sec_review_agents.filesystem.material_views import MaterialView

_DEEPAGENTS_ARTIFACT_VIEWS = (
    MaterialView(
        host_path=None,
        container_path="/conversation_history",
        agent_path="/conversation_history",
        writable=True,
    ),
    MaterialView(
        host_path=None,
        container_path="/large_tool_results",
        agent_path="/large_tool_results",
        writable=True,
    ),
)


def create_backend_with_materials(
    *,
    container_name_prefix: str,
    material_views: list[MaterialView] | None = None,
    working_directory: str = "/workspace",
    image: str | None = None,
    use_docker_sandbox: bool | None = None,
    backend_kind: str | None = None,
):
    if backend_kind is None:
        backend_kind = (
            backend_selection.selected_sandbox_backend_kind()
            if use_docker_sandbox is None
            else ("docker" if use_docker_sandbox else "local")
        )
    backend_kind = backend_kind.strip().lower()
    material_views = list(material_views or [])
    if backend_kind == "docker":
        return _create_docker_material_backend(
            container_name_prefix=container_name_prefix,
            working_directory=working_directory,
            material_views=material_views,
            image=image,
        )
    if backend_kind == "bwrap":
        return _create_bwrap_material_backend(
            working_directory=working_directory,
            material_views=material_views,
        )
    if backend_kind != "local":
        raise ValueError("backend_kind must be one of: docker, local, bwrap")

    routes: dict[str, BackendProtocol] = {}
    for view in material_views:
        if view.host_path is None:
            raise ValueError(
                f"Local backend material view requires a host_path: {view.agent_path}"
            )
        route = (
            view.agent_path if view.agent_path.endswith("/") else f"{view.agent_path}/"
        )
        routes[route] = LocalFilesystemBackend(view.host_path, writable=view.writable)
    return CompositeBackend(
        default=StateBackend(),
        routes=routes,
    )


def _create_bwrap_material_backend(
    *,
    working_directory: str,
    material_views: list[MaterialView],
):
    routes: list[BwrapRoute] = []
    for view in material_views:
        if view.host_path is None:
            raise ValueError(
                f"bwrap backend material view requires a host_path: {view.agent_path}"
            )
        routes.append(
            BwrapRoute(
                host_path=view.host_path,
                agent_path=view.agent_path,
                writable=view.writable,
            )
        )
    return BwrapSandboxBackend(
        routes=routes,
        working_directory=working_directory,
    )


def _create_docker_material_backend(
    *,
    container_name_prefix: str,
    working_directory: str,
    material_views: list[MaterialView],
    image: str | None = None,
):
    """Create the Docker backend that owns command execution and material paths."""
    # Docker remains one sandbox backend instead of a CompositeBackend route
    # tree: command execution, path mapping, and container cleanup all belong to
    # the same container. Material paths are exposed through routes below.
    # Deepagents filesystem middleware offloads oversized messages and tool
    # results here. Docker needs explicit writable roots for those virtual files.
    existing_agent_paths = {
        posixpath.normpath(view.agent_path) for view in material_views
    }
    for view in _DEEPAGENTS_ARTIFACT_VIEWS:
        if posixpath.normpath(view.agent_path) in existing_agent_paths:
            continue
        material_views.append(view)
        existing_agent_paths.add(posixpath.normpath(view.agent_path))

    mounts: list[DockerMount] = []
    routes: list[DockerRoute] = []

    for view in material_views:
        normalized_container_path = view.container_path.rstrip("/") or "/"
        if view.host_path is not None:
            resolved_host_path = view.host_path.resolve()
            # Docker bind mounts require an existing host directory. A missing
            # host path should fail here instead of exposing an unexpected empty
            # mount point to the agent.
            if not resolved_host_path.is_dir():
                raise FileNotFoundError(
                    f"Docker mount host directory does not exist: {resolved_host_path}"
                )
            mounts.append(
                DockerMount(
                    host_path=str(resolved_host_path),
                    container_path=normalized_container_path,
                    writable=view.writable,
                )
            )
        routes.append(
            DockerRoute(
                container_path=normalized_container_path,
                agent_path=view.agent_path,
                writable=view.writable,
            )
        )
    container = create_docker_container_resource(
        container_name_prefix=container_name_prefix,
        mounts=mounts,
        working_directory=working_directory,
        image=image,
    )
    return DockerSandboxBackend(
        container=container,
        routes=routes,
    )
