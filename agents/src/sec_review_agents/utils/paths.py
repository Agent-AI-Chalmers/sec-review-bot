from collections.abc import Mapping
from pathlib import Path
from typing import Any


def required_path(value: object, *, label: str) -> Path:
    if isinstance(value, str) and value.strip():
        return Path(value)
    raise KeyError(f"Missing path: {label}")


def artifact_path(artifact_paths: Mapping[str, Any], key: str) -> Path:
    value = artifact_paths.get(key)
    if isinstance(value, str) and value.strip():
        return Path(value)
    raise KeyError(f"Missing artifact path: {key}")
