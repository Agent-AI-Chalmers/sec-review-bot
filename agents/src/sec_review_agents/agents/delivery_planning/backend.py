from pathlib import Path

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_path_views,
)
from sec_review_agents.filesystem.path_views import (
    read_only_path_view,
    tmp_view_for_backend,
)


def create_repository_delivery_planning_backend(*, patch_root: Path):
    patch_root.mkdir(parents=True, exist_ok=True)

    return create_backend_with_path_views(
        container_name_prefix="repository-delivery-planner",
        path_views=[
            read_only_path_view(agent_path="/patches", host_path=patch_root),
            tmp_view_for_backend("local"),
        ],
        use_docker_sandbox=False,
    )
