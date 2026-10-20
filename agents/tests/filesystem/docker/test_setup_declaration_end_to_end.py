"""End-to-end: a real declaration installs a tool the sandbox can then use.

Bootstrap runs the declaration with network access, then a later command in the
same container can use the installed dependencies -- the property that makes a
setup declaration useful. It installs a small tool via the declaration itself, so it
needs both Docker and network and is skipped when the sandbox has no network.
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

pytestmark = pytest.mark.integration


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
    (workspace / "input.json").write_text(
        '{"name": "e2e", "ready": false}', encoding="utf-8"
    )
    # The property under test is that a declaration's installs are usable by a later command in
    # the same container. `jq` proves it as well as a Node toolchain does, and it installs in a
    # couple of seconds instead of pulling a full runtime and an npm dependency tree.
    setup_declaration = "\n".join(
        [
            "setup:",
            "  - run: apk add --no-cache jq",
            "    timeout_seconds: 240",
        ]
    )

    backend = create_backend_with_path_views(
        container_name_prefix="e2e-bootstrap",
        path_views=[workspace_view(host_path=workspace, writable=True)],
    )
    assert isinstance(backend, DockerSandboxBackend)
    try:
        # Resolve the package mirror instead of running `apk update`. A DNS lookup answers
        # "is there a network" in under a second; `apk update` downloads an index first, so on
        # a slow link it spends minutes doing the very work this check is trying to avoid. The
        # timeout stays as a backstop for a sandbox that cannot even reach a resolver.
        probe = backend.execute(
            "getent hosts dl-cdn.alpinelinux.org >/dev/null 2>&1 "
            "&& echo NET_OK || echo NET_FAIL",
            timeout=30,
        )
        if "NET_OK" not in probe.output:
            pytest.skip("sandbox has no network; bootstrap requires it")
        result = await bootstrap_environment(
            backend, setup_declaration_content=setup_declaration
        )
        assert result.status is BootstrapStatus.COMPLETED, result.reason
        # A later command in the same container can use what the declaration installed, and can
        # act on the mounted workspace while doing it.
        check = backend.execute(
            "cd /workspace && jq -r '.name + \"-ok\"' input.json"
        )
    finally:
        backend.close()

    assert check.exit_code == 0, check.output
    assert "e2e-ok" in check.output
