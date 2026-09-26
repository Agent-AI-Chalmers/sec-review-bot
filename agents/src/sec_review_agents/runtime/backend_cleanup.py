import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from typing import Any, cast

from sec_review_agents.filesystem.docker_runtime import DockerContainerResource


async def aclose_backend_container(backend: Any) -> None:
    """Finalize a backend and stop its Docker resource without blocking asyncio.

    Backends without an async finalizer use their synchronous finalizer in a
    worker thread. Cleanup is best-effort, matching the old teardown behavior:
    a cleanup failure must not hide the activity error that triggered teardown.
    """
    # All async stages use this hook, but most backends are pure command
    # adapters and have nothing to release. Only backends exposing an explicit
    # finalizer or Docker container resource perform teardown below.
    afinalize_backend = getattr(backend, "afinalize", None)
    if callable(afinalize_backend):
        with suppress(Exception):
            await cast(Callable[[], Awaitable[None]], afinalize_backend)()
    else:
        finalize_backend = getattr(backend, "finalize", None)
        if callable(finalize_backend):
            with suppress(Exception):
                await asyncio.to_thread(finalize_backend)
    # Docker owns a long-lived container; bwrap and local backends do not.
    container = getattr(backend, "container", None)
    if isinstance(container, DockerContainerResource):
        with suppress(Exception):
            await asyncio.to_thread(container.close)


@asynccontextmanager
async def amanaged_backend(backend: Any) -> AsyncGenerator[Any]:
    """Manage an async backend lifetime and always run non-blocking cleanup."""
    try:
        yield backend
    finally:
        await aclose_backend_container(backend)
