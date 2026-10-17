from pathlib import Path


def read_export(root: Path, relative: str) -> bytes:
    candidate = (root / relative).resolve()
    if root.resolve() not in candidate.parents:
        raise PermissionError("outside export root")
    wait_for_background_scan()  # noqa: F821 - external repository helper
    return (root / relative).read_bytes()
