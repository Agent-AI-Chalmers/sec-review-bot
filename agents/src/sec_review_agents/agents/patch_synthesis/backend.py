from pathlib import Path

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_path_views,
)
from sec_review_agents.filesystem.path_views import (
    workspace_view,
)


def create_patch_synthesis_backend(
    *,
    workspace_root_path: Path,
    workspace_writable: bool = True,
):
    return create_backend_with_path_views(
        container_name_prefix="patch-synthesizer",
        path_views=[
            workspace_view(
                host_path=workspace_root_path.resolve(),
                writable=workspace_writable,
            ),
        ],
        use_docker_sandbox=False,
    )
