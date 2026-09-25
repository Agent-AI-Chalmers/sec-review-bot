import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.docker_backend import DockerSandboxBackend
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.filesystem.material_views import (
    workspace_view,
)


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
def test_docker_execute_bounds_large_init_commit_diff_output(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _create_large_init_commit_repository(workspace)
    host_result = subprocess.run(
        ["git", "show", "--stat", "--patch", "--root", "HEAD"],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    )
    assert len(host_result.stdout.encode("utf-8")) > 8192

    with patch.dict(
        os.environ,
        {"AGENT_DOCKER_MAX_OUTPUT_BYTES": "8192"},
        clear=False,
    ):
        backend = create_backend_with_materials(
            container_name_prefix="init-diff-bound-test",
            material_views=[
                workspace_view(host_path=workspace, writable=True),
            ],
        )

    assert isinstance(backend, DockerSandboxBackend)
    try:
        result = backend.execute(
            "git show --stat --patch --root HEAD",
        )
    finally:
        backend.container.close()

    assert result.exit_code == 0
    assert result.truncated
    assert len(result.output.encode("utf-8")) <= 8192
    assert result.output.startswith("commit ")


def _create_large_init_commit_repository(
    workspace: Path,
) -> None:
    def run(command: list[str]) -> None:
        subprocess.run(
            command,
            cwd=workspace,
            check=True,
            capture_output=True,
            text=True,
        )

    run(["git", "init"])
    run(["git", "config", "user.email", "test@example.com"])
    run(["git", "config", "user.name", "Test User"])
    # One 16 KiB text file comfortably crosses the 8 KiB output boundary. Using
    # hundreds of files would benchmark Git and mount cleanup, not truncation.
    (workspace / "large.txt").write_text(
        "x" * (16 * 1024 - 1) + "\n",
        encoding="utf-8",
    )
    run(["git", "add", "."])
    run(["git", "commit", "-m", "init"])
