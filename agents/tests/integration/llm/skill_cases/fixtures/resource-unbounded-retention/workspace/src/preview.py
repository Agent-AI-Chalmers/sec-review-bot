import asyncio

pending = set()


async def start_preview(request):
    body = await request.read()
    peer = request.query["peer"]
    task = asyncio.create_task(wait_for_peer(peer, body))
    pending.add(task)
    return {"accepted": True}


async def wait_for_peer(peer, retained_body):
    reader, _writer = await asyncio.open_connection(peer, 443)
    await reader.read()
