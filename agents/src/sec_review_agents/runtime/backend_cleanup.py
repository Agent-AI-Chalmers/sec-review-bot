import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from typing import Any, cast


async def aclose_backend(backend: Any) -> None:
    """End a backend lifetime without exposing its cleanup implementation.

    Async cleanup is preferred; synchronous cleanup runs in a worker thread.
    Cleanup is best-effort so it does not hide the activity error that triggered
    teardown.
    """
    aclose = getattr(backend, "aclose", None)
    if callable(aclose):
        with suppress(Exception):
            await cast(Callable[[], Awaitable[None]], aclose)()
        return

    close = getattr(backend, "close", None)
    if callable(close):
        with suppress(Exception):
            await asyncio.to_thread(close)


@asynccontextmanager
async def amanaged_backend(backend: Any) -> AsyncGenerator[Any]:
    """Manage an async backend lifetime and always run non-blocking cleanup."""
    try:
        yield backend
    finally:
        await aclose_backend(backend)
