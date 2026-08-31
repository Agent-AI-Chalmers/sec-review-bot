import json
from pathlib import Path
from typing import Any


def safe_artifact_filename(filename: str) -> str:
    value = str(filename or "").strip()
    path = Path(value)
    if not value or path.is_absolute() or path.name != value or value in {".", ".."}:
        raise ValueError(f"Artifact filename must be a plain file name: {filename!r}")
    return value


def artifact_path(root: Path, filename: str) -> Path:
    return root / safe_artifact_filename(filename)


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def persist_text_artifact(
    path: Path,
    filename: str,
    content: str,
) -> Path:
    target = artifact_path(path, filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return target


def persist_json(
    path: Path,
    filename: str,
    payload: Any,
) -> None:
    persist_text_artifact(path, filename, json.dumps(payload, indent=2))
