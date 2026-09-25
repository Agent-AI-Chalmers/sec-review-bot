import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from sec_review_agents.filesystem.docker_runtime import (
    default_docker_bin,
    is_docker_runtime_available,
)

_DOCKER_TEST_IMAGE = "sec-review-agents-test:local"


@pytest.fixture(scope="session", autouse=True)
def docker_integration_test_image() -> Iterator[None]:
    """Build one small image for the real-Docker integration test group."""
    if not is_docker_runtime_available(default_docker_bin()):
        yield
        return

    docker_context = Path(__file__).resolve().parent
    # Do not fall back to the large production devcontainer image here. These
    # tests cover backend behavior, so a minimal shell-and-Git image is enough.
    subprocess.run(
        [
            default_docker_bin(),
            "build",
            "--tag",
            _DOCKER_TEST_IMAGE,
            str(docker_context),
        ],
        check=True,
    )

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("AGENT_DOCKER_IMAGE", _DOCKER_TEST_IMAGE)
    try:
        yield
    finally:
        monkeypatch.undo()
