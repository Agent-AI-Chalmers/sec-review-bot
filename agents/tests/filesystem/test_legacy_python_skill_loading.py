"""Opt-in regression using a local Python 3.5/3.6 image without pulling one."""

import os
from pathlib import Path

import pytest
from deepagents.middleware.skills import SkillsMiddleware

from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.docker_backend import DockerSandboxBackend
from sec_review_agents.filesystem.path_views import PathView


@pytest.mark.integration
@pytest.mark.skipif(
    not os.environ.get("LEGACY_PYTHON_TEST_IMAGE"),
    reason="Set LEGACY_PYTHON_TEST_IMAGE to a local image with Python 3.5/3.6 as python3.",
)
@pytest.mark.asyncio
async def test_legacy_python_skill_discovery_and_transfers(tmp_path: Path) -> None:
    """Exercise the real metadata-download path that skipped every skill on Python 3.5/3.6."""
    skill = tmp_path / "example"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: example\ndescription: Runtime probe.\n---\nExample skill.\n"
    )
    backend = create_backend_with_path_views(
        container_name_prefix="legacy-python-skills-test",
        backend_kind="docker",
        image=os.environ["LEGACY_PYTHON_TEST_IMAGE"],
        working_directory="/tmp",
        path_views=[
            PathView(
                host_path=tmp_path,
                container_path="/skills",
                agent_path="/skills",
                writable=False,
            )
        ],
    )
    assert isinstance(backend, DockerSandboxBackend)
    with backend:
        version = backend.execute(
            "python3 -c 'import sys; assert sys.version_info[:2] in [(3, 5), (3, 6)]'"
        )
        assert version.exit_code == 0, version.output
        state = await SkillsMiddleware(
            backend=backend, sources=["/skills/"]
        ).abefore_agent(
            {"messages": []},
            None,  # type: ignore[arg-type]  # Metadata loading does not use Runtime.
            {},
        )
        assert state is not None
        assert [(item["name"], item["path"]) for item in state["skills_metadata"]] == [
            ("example", "/skills/example/SKILL.md")
        ]
        for payload in [b"", bytes(range(256)) * 8193]:
            uploaded = await backend.aupload_files(
                [("/tmp/probe/payload.bin", payload)]
            )
            assert uploaded[0].error is None
            downloaded = await backend.adownload_files(["/tmp/probe/payload.bin"])
            assert downloaded[0].error is None
            assert downloaded[0].content == payload
        target = "/tmp/probe/example.txt"
        assert (await backend.awrite(target, "needle old value\n")).error is None
        listing = await backend.als("/tmp/probe")
        assert listing.error is None
        assert listing.entries and any(
            item["path"] == target for item in listing.entries
        )
        assert backend.ls("/tmp/probe").entries == listing.entries
        assert (await backend.als(target)).error
        assert (await backend.als("/tmp/probe/missing")).error
        read = await backend.aread(target)
        assert read.error is None and read.file_data
        assert read.file_data["content"] == "needle old value"
        globbed = await backend.aglob("**/*.txt", "/tmp/probe")
        assert globbed.error is None and globbed.matches
        found = await backend.agrep("needle", "/tmp", glob="probe/*.txt")
        assert found.error is None and found.matches
        edited = await backend.aedit(target, "old", "new")
        assert edited.error is None and edited.occurrences == 1
        large = "old-large-" + "z" * 60000
        assert (await backend.awrite("/tmp/probe/large.txt", large)).error is None
        assert (
            await backend.aedit("/tmp/probe/large.txt", large, "replacement")
        ).error is None
        assert (await backend.adelete(target)).error is None
        linked = backend.execute("ln -s /skills /tmp/probe/outside")
        assert linked.exit_code == 0, linked.output
        rejected = await backend.adownload_files(
            ["/tmp/probe/outside/example/SKILL.md"]
        )
        assert rejected[0].error == "permission_denied"
