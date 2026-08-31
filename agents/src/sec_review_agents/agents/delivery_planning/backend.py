from pathlib import Path

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.material_views import (
    host_tmp_view,
    read_only_material_view,
)


def create_repository_delivery_planning_backend(*, patch_root: Path):
    patch_root.mkdir(parents=True, exist_ok=True)

    return create_backend_with_materials(
        container_name_prefix="repository-delivery-planner",
        material_views=[
            read_only_material_view(agent_path="/patches", host_path=patch_root),
            host_tmp_view(),
        ],
        use_docker_sandbox=False,
    )
