import asyncio

slots = asyncio.Semaphore(20)


async def handle(request):
    await slots.acquire()
    try:
        return await request.app["backend"].fetch()
    except asyncio.CancelledError:
        return None
