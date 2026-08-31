from importlib.resources.abc import Traversable
from pathlib import Path


def _write_resource_file(path: Path, content: bytes) -> None:
    if path.is_file() and path.read_bytes() == content:
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def materialize_resource_tree(source: Traversable, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    for child in source.iterdir():
        target = destination / child.name
        if child.is_dir():
            materialize_resource_tree(child, target)
        else:
            _write_resource_file(target, child.read_bytes())
    return destination
