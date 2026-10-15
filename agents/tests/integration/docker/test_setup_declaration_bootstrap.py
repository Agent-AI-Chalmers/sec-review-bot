"""Bootstrap runs the flattened declaration steps correctly in a real container.

Exercises the production `bootstrap_environment` against a real docker backend:
the deepagents `execute(command: str)` contract only accepts a full shell
command string, so this proves the `cd ... && export ... && <run>` flattening
actually applies the working directory and environment inside the container.
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
from sec_review_agents.runtime.setup_bootstrap import (
    BootstrapStatus,
    bootstrap_environment,
)


def _docker_available() -> bool:
    return is_docker_runtime_available(default_docker_bin())


def _backend(tmp_path: Path, prefix: str) -> DockerSandboxBackend:
    workspace = tmp_path / "workspace"
    (workspace / "apps" / "svc").mkdir(parents=True, exist_ok=True)
    (workspace / "apps" / "svc" / "marker.txt").write_text("ok\n", encoding="utf-8")
    backend = create_backend_with_path_views(
        container_name_prefix=prefix,
        path_views=[workspace_view(host_path=workspace, writable=True)],
    )
    assert isinstance(backend, DockerSandboxBackend)
    return backend


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
async def test_bootstrap_applies_working_directory_and_env(tmp_path: Path) -> None:
    setup = tmp_path / "setup.yml"
    setup.write_text(
        "\n".join(
            [
                "setup:",
                "  - run: pwd && cat marker.txt && printf '%s' \"$NODE_ENV\"",
                "    working-directory: apps/svc",
                "    env:",
                "      NODE_ENV: development",
            ]
        ),
        encoding="utf-8",
    )
    backend = _backend(tmp_path, "bootstrap-it")
    try:
        result = await bootstrap_environment(backend, setup_declaration_path=setup)
    finally:
        backend.close()

    assert result.status is BootstrapStatus.COMPLETED
    output = result.steps[0].output
    assert "/workspace/apps/svc" in output
    assert "ok" in output
    assert "development" in output


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
async def test_bootstrap_marks_incomplete_on_nonzero_step(tmp_path: Path) -> None:
    setup = tmp_path / "setup.yml"
    setup.write_text(
        "setup:\n  - run: 'exit 7'\n  - run: echo never\n", encoding="utf-8"
    )
    backend = _backend(tmp_path, "bootstrap-it-fail")
    try:
        result = await bootstrap_environment(backend, setup_declaration_path=setup)
    finally:
        backend.close()

    assert result.status is BootstrapStatus.INCOMPLETE
    assert len(result.steps) == 1
    assert result.steps[0].exit_code == 7
