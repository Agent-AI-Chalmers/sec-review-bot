"""End-to-end: a real declaration installs a tool the sandbox can then use.

Bootstrap runs the declaration, then a later command in the same container can
use the installed tool -- the persistence property that makes setup useful.
"""

from pathlib import Path

import pytest

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_path_views,
)
from sec_review_agents.filesystem.docker_backend import DockerSandboxBackend
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.filesystem.path_views import workspace_view
from sec_review_agents.runtime.backend_cleanup import amanaged_backend
from sec_review_agents.runtime.setup_bootstrap import (
    BootstrapStatus,
    bootstrap_environment,
)

pytestmark = pytest.mark.integration


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
async def test_declaration_installs_tool_usable_by_later_commands(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "input.json").write_text(
        '{"name": "e2e", "ready": false}', encoding="utf-8"
    )
    (workspace / "e2e-name").write_text(
        '#!/bin/sh\nawk -F\'"\' \'{print $4 "-ok"}\' "$1"\n',
        encoding="utf-8",
    )
    # Install a workspace-provided CLI instead of depending on a public package
    # repository. The behavior under test is persistence across commands in one
    # sandbox, not Alpine mirror availability.
    setup_declaration = "\n".join(
        [
            "setup:",
            "  - run: install -m 0755 /workspace/e2e-name /usr/local/bin/e2e-name",
        ]
    )

    backend = create_backend_with_path_views(
        container_name_prefix="e2e-bootstrap",
        path_views=[workspace_view(host_path=workspace, writable=True)],
    )
    assert isinstance(backend, DockerSandboxBackend)
    async with amanaged_backend(backend):
        result = await bootstrap_environment(
            backend, setup_declaration_content=setup_declaration
        )
        assert result.status is BootstrapStatus.COMPLETED, result.reason
        # A later command in the same container can use what the declaration installed, and can
        # act on the mounted workspace while doing it.
        check = backend.execute("cd /workspace && e2e-name input.json")

    assert check.exit_code == 0, check.output
    assert "e2e-ok" in check.output
