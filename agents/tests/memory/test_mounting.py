from pathlib import Path
from unittest.mock import patch

from sec_review_agents.agents.analysis.issue import build_issue_analyzer_backend_config
from sec_review_agents.agents.mitigation.repository import (
    build_repository_mitigation_backend_config,
)
from sec_review_agents.agents.verification.pull_request import (
    build_pr_verification_backend_config,
)
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.path_views import memory_view


def _default_routes_for(backend) -> dict:
    routes = getattr(backend, "routes", None)
    if isinstance(routes, dict):
        return routes
    composite = getattr(backend, "composite", backend)
    default_backend = getattr(composite, "default", None)
    if default_backend is None:
        default_backend = getattr(backend, "default_backend", None)
    routes = getattr(default_backend, "routes", None)
    if isinstance(routes, dict):
        return routes
    raise AssertionError("Expected backend default to expose composite routes.")


def _default_route_root(backend, route: str) -> Path:
    route_backend = _default_routes_for(backend)[route]
    root_dir = getattr(route_backend, "root_dir", None)
    if isinstance(root_dir, Path):
        return root_dir
    raise AssertionError(f"Expected {route} to route to a local filesystem backend.")


def _default_route_writable(backend, route: str) -> bool:
    return bool(getattr(_default_routes_for(backend)[route], "writable", False))


def test_review_backends_mount_materialized_memory_view_when_configured(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "local" / "workspace"
    history = tmp_path / "local" / "history"
    incremental = tmp_path / "local" / "incremental-window"
    memory_materialized = tmp_path / "memory-materialized"
    for path in (workspace, history, incremental, memory_materialized / "topics"):
        path.mkdir(parents=True, exist_ok=True)
    (memory_materialized / "MEMORY.md").write_text(
        "# Memory\n\n- Mounted memory lesson.\n",
        encoding="utf-8",
    )

    with patch(
        # The memory view is what this test checks, so the sandbox is pinned rather
        # than resolved: `local` is not a deployment value, and the real
        # resolution would look for Docker.
        "sec_review_agents.filesystem.backend_selection."
        "selected_sandbox_backend_kind",
        return_value="local",
    ):
        mounted_memory = memory_view(host_path=memory_materialized)
        configs = (
            build_issue_analyzer_backend_config(
                workspace_root_path=workspace, history_path=history
            ),
            build_pr_verification_backend_config(
                workspace_root_path=workspace,
                history_path=history,
                incremental_window_path=incremental,
            ),
            build_repository_mitigation_backend_config(
                workspace_root=workspace,
                history_path=None,
                incremental_window_path=None,
                scan_mode="full",
            ),
        )
        backends = []
        for config in configs:
            config["path_views"].append(mounted_memory)
            backends.append(create_backend_with_path_views(**config))

    for backend in backends:
        memory_root = _default_route_root(backend, "/memory/")
        assert memory_root == memory_materialized.resolve()
        assert (memory_root / "MEMORY.md").read_text(encoding="utf-8") == (
            "# Memory\n\n- Mounted memory lesson.\n"
        )
        assert not _default_route_writable(backend, "/memory/")
