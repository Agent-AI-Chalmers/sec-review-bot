from pathlib import Path

ROOT = Path("/srv/exports")


def download(relative):
    target = (ROOT / relative).resolve()
    if not target.is_relative_to(ROOT):
        raise PermissionError()
    return target.read_bytes()
