"""End-to-end: a real declaration installs real dependencies in the sandbox.

Bootstrap runs the declaration with network access, then a later command in the
same container can use the installed dependencies -- the property that makes a
setup declaration useful. It uses the small integration image and installs node/npm
via the declaration itself, so it needs both Docker and network and is skipped
when either is unavailable.
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


@pytest.mark.asyncio
@pytest.mark.skipif(
    not _docker_available(),
    reason="Docker runtime is not available in this environment.",
)
async def test_declaration_installs_dependencies_usable_by_later_commands(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Bootstrap requires network, and the sandbox network mode is fixed at
    # container creation from AGENT_DOCKER_NETWORK_MODE. pytest does not load
    # agents/.env, so pin the same baseline the deployer uses.
    monkeypatch.setenv("AGENT_DOCKER_NETWORK_MODE", "bridge")

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "package.json").write_text(
        '{"name":"e2e","version":"1.0.0","dependencies":{"is-odd":"3.0.1"}}',
        encoding="utf-8",
    )
    setup_declaration = "\n".join(
        [
            "setup:",
            "  - run: apk add --no-cache nodejs npm",
            "    timeout_seconds: 240",
            "  - run: npm install --no-audit --no-fund",
            "    timeout_seconds: 240",
        ]
    )

    backend = create_backend_with_path_views(
        container_name_prefix="e2e-bootstrap",
        path_views=[workspace_view(host_path=workspace, writable=True)],
    )
    assert isinstance(backend, DockerSandboxBackend)
    try:
        probe = backend.execute(
            "apk update >/dev/null 2>&1 && echo NET_OK || echo NET_FAIL"
        )
        if "NET_OK" not in probe.output:
            pytest.skip("sandbox has no network; bootstrap requires it")
        result = await bootstrap_environment(
            backend, setup_declaration_content=setup_declaration
        )
        assert result.status is BootstrapStatus.COMPLETED, result.reason
        # A later command in the same container can use the installed dependency.
        check = backend.execute(
            "cd /workspace && node -e \"require('is-odd'); console.log('dep-ok')\""
        )
    finally:
        backend.close()

    assert check.exit_code == 0, check.output
    assert "dep-ok" in check.output
