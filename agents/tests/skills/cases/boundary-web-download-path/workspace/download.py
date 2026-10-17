from pathlib import Path


def download(request):
    return Path("/srv/exports", request.query["file"]).read_bytes()
