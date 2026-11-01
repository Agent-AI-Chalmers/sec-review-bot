"""Run upstream shell helpers against real files, without starting a container.

These probes exercise routing, transfer, and helper output end to end. Runtime
isolation and transfer attack cases remain in their dedicated tests.
"""

import asyncio
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from deepagents.backends.protocol import ExecuteResponse

from sec_review_agents.filesystem.docker_backend import DockerRoute
from tests.filesystem.test_docker_backend import _backend


@pytest.fixture
def routed_backend(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "keep.txt").write_text("keep")
    backend = _backend(
        routes=[
            DockerRoute(str(workspace), "/workspace", True),
            DockerRoute(str(reference), "/reference", False),
        ]
    )
    agent_root, readonly_root = "/workspace", "/reference"

    def execute(command, *, timeout=None):
        result = subprocess.run(
            command,
            check=False,
            shell=True,
            capture_output=True,
            text=True,
            timeout=10,
            cwd=workspace,
        )
        return ExecuteResponse(
            output=result.stdout + result.stderr, exit_code=result.returncode
        )

    async def aexecute(command, *, timeout=None):
        return await asyncio.to_thread(execute, command, timeout=timeout)

    def transfer(*, script, input_bytes, **kwargs):
        return subprocess.run(
            [sys.executable, "-c", script],
            check=False,
            input=input_bytes,
            capture_output=True,
            timeout=10,
        )

    with (
        patch.object(backend, "execute", side_effect=execute),
        patch.object(backend, "aexecute", side_effect=aexecute),
        patch(
            "sec_review_agents.filesystem.docker_runtime.DockerContainerResource.ensure_started"
        ),
        patch(
            "sec_review_agents.filesystem.docker_runtime.transfer_with_container_helper",
            side_effect=transfer,
        ),
    ):
        yield backend, workspace, agent_root, readonly_root


@pytest.mark.asyncio
async def test_upstream_helpers_preserve_route_mapping(routed_backend):
    backend, workspace, root, _ = routed_backend
    path = root + "/nested/app.py"
    assert (await backend.awrite(path, "first\nneedle\nlast\n")).error is None
    assert (workspace / "nested/app.py").read_text() == "first\nneedle\nlast\n"
    read = await backend.aread(path, offset=1, limit=1)
    assert read.error is None
    assert read.file_data and read.file_data["content"] == "needle"
    assert read.start_line == 2 and read.next_offset == 2
    listed = await backend.als(root + "/nested")
    assert listed.error is None
    assert listed.entries and listed.entries[0]["path"] == path
    globbed = await backend.aglob("**/*.py", root)
    assert globbed.error is None
    assert globbed.matches and globbed.matches[0]["path"] == path
    found = await backend.agrep("needle", root)
    assert found.error is None
    assert found.matches and found.matches[0]["path"] == path
    edited = await backend.aedit(path, "needle", "replacement")
    assert edited.error is None and edited.path == path
    assert (workspace / "nested/app.py").read_text() == "first\nreplacement\nlast\n"
    assert (await backend.adelete(path)).error is None
    assert not (workspace / "nested/app.py").exists()


@pytest.mark.asyncio
async def test_mutation_policy_precedes_upstream_execution(routed_backend):
    backend, _, _, readonly = routed_backend
    with (
        patch.object(
            backend, "execute", side_effect=AssertionError("must not execute")
        ),
        patch.object(
            backend, "aexecute", side_effect=AssertionError("must not execute")
        ),
    ):
        for root in [readonly, "/unmapped"]:
            path = root + "/keep.txt"
            assert backend.write(path, "change").error
            assert backend.edit(path, "keep", "change").error
            assert backend.delete(path).error
            assert (await backend.awrite(path, "change")).error
            assert (await backend.aedit(path, "keep", "change")).error
            assert (await backend.adelete(path)).error


@pytest.mark.asyncio
@pytest.mark.parametrize("old_found", [True, False])
async def test_large_edit_uses_upstream_tmp_and_cleans_up(routed_backend, old_found):
    backend, workspace, root, _ = routed_backend
    path = root + "/large.txt"
    original = "a" * 30000
    (workspace / "large.txt").write_text(original)
    with patch.object(backend, "upload_files", wraps=backend.upload_files) as upload:
        result = await backend.aedit(
            path, original if old_found else "b" * 30000, "c" * 30000
        )
    staged_paths = [name for call in upload.call_args_list for name, _ in call.args[0]]
    assert len(staged_paths) == 2
    assert all(name.startswith("/tmp/.deepagents_edit_") for name in staged_paths)
    assert all(not Path(name).exists() for name in staged_paths)
    if old_found:
        assert result.path == path
    assert bool(result.error) is not old_found
    assert (workspace / "large.txt").read_text() == (
        "c" * 30000 if old_found else original
    )
    assert not list(workspace.glob(".deepagents_edit_*"))
