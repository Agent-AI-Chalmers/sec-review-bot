import asyncio
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any, cast

_logger = logging.getLogger(__name__)


async def aclose_backend(backend: Any) -> None:
    """End a backend lifetime without exposing its cleanup implementation.

    Async cleanup is preferred; synchronous cleanup runs in a worker thread.
    Cleanup is best-effort: failures are logged without changing the stage result.
    """
    try:
        aclose = getattr(backend, "aclose", None)
        if callable(aclose):
            await cast(Callable[[], Awaitable[None]], aclose)()
            return

        close = getattr(backend, "close", None)
        if callable(close):
            await asyncio.to_thread(close)
    except Exception:
        _logger.warning("Backend cleanup failed", exc_info=True)


@asynccontextmanager
async def amanaged_backend(backend: Any) -> AsyncGenerator[Any]:
    """Manage an async backend lifetime and always run non-blocking cleanup."""
    try:
        yield backend
    finally:
        await aclose_backend(backend)
