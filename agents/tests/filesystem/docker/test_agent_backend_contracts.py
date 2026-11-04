import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.agents.analysis.repository import (
    build_repository_analyzer_backend_config,
)
from sec_review_agents.agents.patch_synthesis.backend import (
    create_patch_synthesis_backend,
)
from sec_review_agents.agents.verification.repository import (
    build_repository_verification_backend_config,
)
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.docker_backend import DockerSandboxBackend
from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.workspace.commits import resolve_workspace_commit


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not _docker_available(),
        reason="Docker runtime is not available in this environment.",
    ),
]


def test_repository_analyzer_docker_tmp_write_and_execute_contract(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="docker",
    ):
        backend = create_backend_with_path_views(
            **build_repository_analyzer_backend_config(
                workspace_root_path=workspace,
                history_path=None,
                incremental_window_path=None,
                scan_mode="full",
            )
        )
    assert isinstance(backend, DockerSandboxBackend)

    marker = uuid.uuid4().hex
    tmp_file = f"/tmp/ghsb-docker-{marker}.txt"
    with backend:
        write_result = backend.write(tmp_file, "ok")
        assert write_result.error is None

        execute_result = backend.execute(f"test -f {tmp_file}")
        assert execute_result.exit_code == 0, (
            "expected file to exist in container /tmp, "
            f"got output: {execute_result.output}"
        )


def test_repository_verifier_docker_tmp_execute_contract(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="docker",
    ):
        backend = create_backend_with_path_views(
            **build_repository_verification_backend_config(
                workspace_root_path=workspace,
                history_path=None,
                incremental_window_path=None,
                scan_mode="full",
            )
        )
    assert isinstance(backend, DockerSandboxBackend)

    with backend:
        assert hasattr(backend, "execute")
        execute_result = backend.execute("pwd")
        assert execute_result.exit_code == 0, (
            "expected verifier backend execute to succeed, "
            f"got output: {execute_result.output}"
        )


def test_patch_synthesis_backend_can_commit_delivery(tmp_path: Path) -> None:
    """Synthesis needs execution to satisfy the committed-delivery contract."""
    backend = create_patch_synthesis_backend(workspace_root_path=tmp_path)
    assert isinstance(backend, DockerSandboxBackend)
    with backend:
        result = backend.execute(
            "cd /workspace && git init -q && "
            "git config user.name Probe && git config user.email probe@localhost && "
            "printf 'repair\\n' > repair.txt && git add repair.txt && "
            "git commit -qm repair && git show HEAD:repair.txt"
        )
        assert result.exit_code == 0, result.output
        assert "repair" in result.output
    assert resolve_workspace_commit(tmp_path)
