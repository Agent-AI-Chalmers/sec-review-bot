import subprocess
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.agents.analysis.repository import (
    create_repository_analyzer_backend,
)
from sec_review_agents.agents.verification.repository import (
    create_repository_verification_backend,
)
from sec_review_agents.filesystem.docker_runtime import (
    DEFAULT_DOCKER_SANDBOX_IMAGE,
    default_docker_bin,
    is_docker_runtime_available,
)
from sec_review_agents.utils.env import env_value


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


def _workspace_image() -> str:
    return env_value("AGENT_DOCKER_IMAGE") or DEFAULT_DOCKER_SANDBOX_IMAGE


def _docker_image_available(image: str) -> bool:
    try:
        result = subprocess.run(
            [default_docker_bin(), "image", "inspect", image],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return False
    return result.returncode == 0


pytestmark = [
    pytest.mark.skipif(
        not _docker_available(),
        reason="Docker runtime is not available in this environment.",
    ),
    pytest.mark.skipif(
        not _docker_image_available(_workspace_image()),
        reason=f"Docker workspace image is not available locally: {_workspace_image()}",
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
        backend = create_repository_analyzer_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    marker = uuid.uuid4().hex
    tmp_file = f"/tmp/ghsb-docker-{marker}.txt"
    try:
        write_result = backend.write(tmp_file, "ok")
        assert write_result.error is None

        execute_result = backend.execute(f"test -f {tmp_file}")
        assert execute_result.exit_code == 0, (
            "expected file to exist in container /tmp, "
            f"got output: {execute_result.output}"
        )
    finally:
        close = getattr(backend, "close", None)
        if callable(close):
            close()


def test_repository_verifier_docker_tmp_execute_contract(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)

    with patch(
        "sec_review_agents.filesystem.backend_selection.selected_sandbox_backend_kind",
        return_value="docker",
    ):
        backend = create_repository_verification_backend(
            workspace_root_path=workspace,
            history_path=None,
            incremental_window_path=None,
            scan_mode="full",
        )

    try:
        assert hasattr(backend, "execute")
        execute_result = backend.execute("pwd")
        assert execute_result.exit_code == 0, (
            "expected verifier backend execute to succeed, "
            f"got output: {execute_result.output}"
        )
    finally:
        close = getattr(backend, "close", None)
        if callable(close):
            close()
