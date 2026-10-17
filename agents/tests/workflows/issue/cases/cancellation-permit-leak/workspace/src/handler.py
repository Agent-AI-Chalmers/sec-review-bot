import asyncio


async def handle_request(limiter, backend):
    await limiter.acquire()
    try:
        return await backend.fetch()
    except asyncio.CancelledError:
        return None
    limiter.release()
