from collections.abc import Iterator
from contextlib import contextmanager, suppress
from typing import Any

from sec_review_agents.filesystem.docker_runtime import DockerContainerResource


def close_backend_container(backend: Any) -> None:
    container = getattr(backend, "container", None)
    if isinstance(container, DockerContainerResource):
        with suppress(Exception):
            container.close()


@contextmanager
def managed_backend(backend: Any) -> Iterator[Any]:
    try:
        yield backend
    finally:
        close_backend_container(backend)
