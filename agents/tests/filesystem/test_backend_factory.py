import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from deepagents.backends import CompositeBackend

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.backend_selection import (
    selected_sandbox_backend_kind,
)
from sec_review_agents.filesystem.bwrap_backend import (
    BwrapRoute,
    BwrapSandboxBackend,
)
from sec_review_agents.filesystem.docker_backend import DockerRoute
from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend
from sec_review_agents.filesystem.material_views import (
    MaterialView,
    container_tmp_view,
    host_tmp_view,
    read_only_material_view,
    tmp_view_for_backend,
    workspace_view,
)


def test_container_tmp_view_uses_container_native_tmp() -> None:
    assert container_tmp_view() == MaterialView(
        host_path=None,
        container_path="/tmp",
        agent_path="/tmp",
        writable=True,
    )


def test_host_tmp_view_uses_host_tempdir() -> None:
    host_path = Path(tempfile.gettempdir())

    assert host_tmp_view() == MaterialView(
        host_path=host_path,
        container_path="/tmp",
        agent_path="/tmp",
        writable=True,
    )


@pytest.mark.parametrize("container_path", ["", "   "])
def test_material_view_rejects_empty_container_path(
    tmp_path: Path,
    container_path: str,
) -> None:
    with pytest.raises(ValueError, match="container_path must be non-empty"):
        MaterialView(
            host_path=tmp_path,
            container_path=container_path,
            agent_path="/workspace",
        )


@pytest.mark.parametrize("agent_path", ["", "   "])
def test_material_view_rejects_empty_agent_path(
    tmp_path: Path,
    agent_path: str,
) -> None:
    with pytest.raises(ValueError, match="agent_path must be non-empty"):
        MaterialView(
            host_path=tmp_path,
            container_path="/workspace",
            agent_path=agent_path,
        )


def test_local_backend_routes_use_agent_path(tmp_path: Path) -> None:
    backend = create_backend_with_materials(
        container_name_prefix="test",
        material_views=[
            read_only_material_view(
                agent_path="/workspace",
                host_path=tmp_path,
                container_path="/mnt/material/workspace",
            )
        ],
        use_docker_sandbox=False,
    )

    assert "/workspace/" in backend.routes
    assert "/mnt/material/workspace/" not in backend.routes


def test_auto_backend_selection_does_not_select_bwrap() -> None:
    with (
        patch.dict("os.environ", {}, clear=True),
        patch(
            "sec_review_agents.filesystem.docker_runtime.shutil.which",
            return_value=None,
        ),
    ):
        assert selected_sandbox_backend_kind() == "local"


def test_backend_selection_can_be_forced_to_bwrap() -> None:
    with patch.dict("os.environ", {"AGENT_SANDBOX_BACKEND": "bwrap"}, clear=True):
        assert selected_sandbox_backend_kind() == "bwrap"


def test_tmp_view_follows_backend_kind() -> None:
    assert tmp_view_for_backend("docker") == container_tmp_view()
    assert tmp_view_for_backend("local") == host_tmp_view()
    assert tmp_view_for_backend("bwrap") is None


def test_environment_can_select_bwrap_backend_factory(tmp_path: Path) -> None:
    with patch.dict("os.environ", {"AGENT_SANDBOX_BACKEND": "bwrap"}, clear=True):
        backend = create_backend_with_materials(
            container_name_prefix="test",
            material_views=[workspace_view(host_path=tmp_path, writable=True)],
        )

    assert isinstance(backend, BwrapSandboxBackend)


def test_bwrap_backend_uses_agent_paths_without_composite_routes(
    tmp_path: Path,
) -> None:
    backend = create_backend_with_materials(
        container_name_prefix="test",
        material_views=[workspace_view(host_path=tmp_path, writable=True)],
        backend_kind="bwrap",
    )

    assert isinstance(backend, BwrapSandboxBackend)
    assert (
        BwrapRoute(
            host_path=tmp_path,
            agent_path="/workspace",
            writable=True,
        )
        in backend.routes
    )
    assert backend._is_allowed_path("/workspace/app.py")


def test_local_backend_routes_agent_workspace_to_host_backend(tmp_path: Path) -> None:
    backend = create_backend_with_materials(
        container_name_prefix="test",
        material_views=[
            workspace_view(host_path=tmp_path, writable=True),
        ],
        use_docker_sandbox=False,
    )

    assert isinstance(backend, CompositeBackend)
    route = backend.routes["/workspace/"]
    assert isinstance(route, LocalFilesystemBackend)
    assert route.root_dir == tmp_path
    assert route.writable


def test_local_backend_routes_respect_writable_views(
    tmp_path: Path,
) -> None:
    backend = create_backend_with_materials(
        container_name_prefix="test",
        material_views=[
            workspace_view(host_path=tmp_path, writable=False),
        ],
        use_docker_sandbox=False,
    )

    assert isinstance(backend, CompositeBackend)
    route = backend.routes["/workspace/"]
    assert isinstance(route, LocalFilesystemBackend)
    assert route.root_dir == tmp_path
    assert not route.writable


def test_docker_backend_mounts_use_container_path(tmp_path: Path) -> None:
    with patch(
        "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        return_value=object(),
    ) as docker_backend_cls:
        backend = create_backend_with_materials(
            container_name_prefix="test",
            material_views=[
                read_only_material_view(
                    agent_path="/workspace",
                    host_path=tmp_path,
                    container_path="/mnt/material/workspace",
                ),
                container_tmp_view(),
            ],
            use_docker_sandbox=True,
        )

    assert backend is docker_backend_cls.return_value
    assert not isinstance(backend, CompositeBackend)
    container = docker_backend_cls.call_args.kwargs["container"]
    docker_mounts = container.mounts
    routes = docker_backend_cls.call_args.kwargs["routes"]
    assert len(docker_mounts) == 1
    assert len(routes) == 4
    assert docker_mounts[0].host_path == str(tmp_path.resolve())
    assert docker_mounts[0].container_path == "/mnt/material/workspace"
    assert not docker_mounts[0].writable
    assert (
        DockerRoute(
            container_path="/mnt/material/workspace",
            agent_path="/workspace",
            writable=False,
        )
        in routes
    )
    assert (
        DockerRoute(
            container_path="/tmp",
            agent_path="/tmp",
            writable=True,
        )
        in routes
    )


def test_docker_backend_adds_deepagents_artifact_roots() -> None:
    with patch(
        "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        return_value=object(),
    ) as docker_backend_cls:
        create_backend_with_materials(
            container_name_prefix="test",
            material_views=[container_tmp_view()],
            use_docker_sandbox=True,
        )

    container = docker_backend_cls.call_args.kwargs["container"]
    routes = docker_backend_cls.call_args.kwargs["routes"]
    assert not any(
        mount.container_path in {"/conversation_history", "/large_tool_results"}
        for mount in container.mounts
    )
    assert (
        DockerRoute(
            container_path="/conversation_history",
            agent_path="/conversation_history",
            writable=True,
        )
        in routes
    )
    assert (
        DockerRoute(
            container_path="/large_tool_results",
            agent_path="/large_tool_results",
            writable=True,
        )
        in routes
    )


def test_docker_backend_allows_container_native_material_view() -> None:
    with patch(
        "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        return_value=object(),
    ) as docker_backend_cls:
        backend = create_backend_with_materials(
            container_name_prefix="test",
            material_views=[
                MaterialView(
                    host_path=None,
                    container_path="/opt/native-tools",
                    agent_path="/tools",
                    writable=False,
                ),
                container_tmp_view(),
            ],
            use_docker_sandbox=True,
        )

    assert backend is docker_backend_cls.return_value
    container = docker_backend_cls.call_args.kwargs["container"]
    routes = docker_backend_cls.call_args.kwargs["routes"]
    assert container.mounts == []
    assert len(routes) == 4
    assert (
        DockerRoute(
            container_path="/opt/native-tools",
            agent_path="/tools",
            writable=False,
        )
        in routes
    )
    assert (
        DockerRoute(
            container_path="/tmp",
            agent_path="/tmp",
            writable=True,
        )
        in routes
    )


def test_docker_backend_does_not_add_implicit_tmp_material_view(tmp_path: Path) -> None:
    with patch(
        "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        return_value=object(),
    ) as docker_backend_cls:
        create_backend_with_materials(
            container_name_prefix="test",
            material_views=[
                read_only_material_view(
                    agent_path="/workspace",
                    host_path=tmp_path,
                )
            ],
            use_docker_sandbox=True,
        )

    routes = docker_backend_cls.call_args.kwargs["routes"]
    assert (
        DockerRoute(
            container_path="/tmp",
            agent_path="/tmp",
            writable=True,
        )
        not in routes
    )


def test_docker_backend_mounts_host_tmp_view() -> None:
    with patch(
        "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
        return_value=object(),
    ) as docker_backend_cls:
        create_backend_with_materials(
            container_name_prefix="test",
            material_views=[host_tmp_view()],
            use_docker_sandbox=True,
        )

    container = docker_backend_cls.call_args.kwargs["container"]
    assert len(container.mounts) == 1
    assert container.mounts[0].host_path == str(Path(tempfile.gettempdir()).resolve())
    assert container.mounts[0].container_path == "/tmp"
    assert container.mounts[0].writable


def test_local_backend_rejects_container_native_material_view() -> None:
    with pytest.raises(
        ValueError,
        match="Local backend material view requires a host_path: /tools",
    ):
        create_backend_with_materials(
            container_name_prefix="test",
            material_views=[
                MaterialView(
                    host_path=None,
                    container_path="/opt/native-tools",
                    agent_path="/tools",
                    writable=False,
                )
            ],
            use_docker_sandbox=False,
        )


def test_docker_backend_explicit_image_overrides_environment_image(
    tmp_path: Path,
) -> None:
    with (
        patch.dict(
            "os.environ",
            {"AGENT_DOCKER_IMAGE": "env-image:latest"},
            clear=False,
        ),
        patch(
            "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
            return_value=object(),
        ) as docker_backend_cls,
    ):
        create_backend_with_materials(
            container_name_prefix="test",
            material_views=[
                read_only_material_view(
                    agent_path="/workspace",
                    host_path=tmp_path,
                )
            ],
            image="explicit-image:latest",
            use_docker_sandbox=True,
        )

    container = docker_backend_cls.call_args.kwargs["container"]
    assert container.image == "explicit-image:latest"


def test_docker_material_view_rejects_missing_source_directory(tmp_path: Path) -> None:
    missing_source = tmp_path / "missing-material"

    with (
        patch(
            "sec_review_agents.filesystem.backend_factory.DockerSandboxBackend",
            return_value=object(),
        ),
        pytest.raises(FileNotFoundError),
    ):
        create_backend_with_materials(
            container_name_prefix="test",
            material_views=[
                read_only_material_view(
                    agent_path="/material",
                    host_path=missing_source,
                )
            ],
            use_docker_sandbox=True,
        )

    assert not missing_source.exists()
