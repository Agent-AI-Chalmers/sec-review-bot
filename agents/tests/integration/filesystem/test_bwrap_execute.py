from pathlib import Path

import pytest

from sec_review_agents.filesystem.bwrap_backend import (
    BwrapRoute,
    BwrapSandboxBackend,
)
from sec_review_agents.filesystem.bwrap_runtime import is_bwrap_runtime_available


@pytest.mark.skipif(
    not is_bwrap_runtime_available(),
    reason="bwrap runtime is not available in this environment.",
)
def test_bwrap_executes_with_workspace_and_private_tmp(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    backend = BwrapSandboxBackend(
        routes=[
            BwrapRoute(
                host_path=workspace,
                agent_path="/workspace",
                writable=True,
            )
        ],
        working_directory="/workspace",
    )

    write_result = backend.execute(
        "printf ok > /workspace/result.txt && cat /workspace/result.txt",
        timeout=5,
    )
    read_host = backend.execute("cat /etc/passwd", timeout=5)
    tmp_result = backend.execute(
        "printf private > /tmp/bwrap-probe && test ! -e /workspace/bwrap-probe && printf ok",
        timeout=5,
    )

    assert write_result.exit_code == 0
    assert write_result.output.strip() == "ok"
    assert read_host.exit_code == 1
    assert "No such file or directory" in read_host.output
    assert tmp_result.exit_code == 0
    assert tmp_result.output.strip() == "ok"
    assert (workspace / "result.txt").read_text() == "ok"
