import json
import shutil
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

JSON_SUFFIX = ".json"


def slug_filename_component(value: str, *, fallback: str) -> str:
    """Normalize one filename component while preserving Unicode letters."""
    slug = "".join(
        character.lower() if character.isalnum() else "-" for character in value.strip()
    ).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or fallback


def reset_stage_attempt_artifacts(
    root: Path,
    *,
    filenames: Sequence[str] = (),
    directories: Sequence[str] = (),
) -> None:
    for filename in filenames:
        (root / filename).unlink(missing_ok=True)
    for directory in directories:
        shutil.rmtree(root / directory, ignore_errors=True)


def safe_artifact_filename(filename: str) -> str:
    value = str(filename or "").strip()
    path = Path(value)
    if not value or path.is_absolute() or path.name != value or value in {".", ".."}:
        raise ValueError(f"Artifact filename must be a plain file name: {filename!r}")
    return value


def artifact_path(root: Path, filename: str) -> Path:
    return root / safe_artifact_filename(filename)


def json_artifact_path(root: Path, stem: str) -> Path:
    normalized = safe_artifact_filename(stem)
    if normalized.endswith(JSON_SUFFIX):
        raise ValueError(f"JSON artifact name must omit {JSON_SUFFIX}: {stem!r}")
    return root / f"{normalized}{JSON_SUFFIX}"


def remove_json_artifacts(root: Path, stems: Iterable[str]) -> None:
    for stem in stems:
        json_artifact_path(root, stem).unlink(missing_ok=True)


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


def persist_json_artifact(
    path: Path,
    stem: str,
    payload: Any,
) -> None:
    target = json_artifact_path(path, stem)
    target.parent.mkdir(parents=True, exist_ok=True)
    write_json(target, payload)
