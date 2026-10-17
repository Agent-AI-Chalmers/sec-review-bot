from pathlib import Path

ROOT = Path("/srv/exports")


def download(relative, checked, resume):
    target = (ROOT / relative).resolve()
    if not target.is_relative_to(ROOT):
        raise PermissionError()
    checked.set()
    resume.wait()
    return target.read_bytes()
