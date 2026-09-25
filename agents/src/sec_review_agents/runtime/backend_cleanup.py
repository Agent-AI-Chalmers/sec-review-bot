from collections.abc import Iterator
from contextlib import contextmanager, suppress
from typing import Any

from sec_review_agents.filesystem.docker_runtime import DockerContainerResource


def close_backend_container(backend: Any) -> None:
    finalize_backend = getattr(backend, "finalize", None)
    if callable(finalize_backend):
        with suppress(Exception):
            finalize_backend()
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
