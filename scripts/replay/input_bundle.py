import json
from pathlib import Path
from typing import Any

from sec_review_agents.utils.env import env_value
from sec_review_agents.workspace.snapshots import (
    ARTIFACT_WORKSPACE_DIR_NAME,
    restore_workspace_from_snapshot_tar,
)

INPUT_BUNDLE_MANIFEST_NAME = "manifest.json"
ARTIFACT_ROOT_ENV = "SEC_REVIEW_AGENT_ARTIFACT_ROOT"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def default_replay_artifact_root(
    *, input_bundle_root: Path, run_id: str | None = None
) -> Path:
    configured_root = env_value(ARTIFACT_ROOT_ENV)
    if configured_root is not None:
        if not run_id:
            raise ValueError(
                f"{ARTIFACT_ROOT_ENV} requires run_id to derive replay artifact root."
            )
        return Path(configured_root) / run_id
    return input_bundle_root / "artifacts"


def _manifest_path(input_bundle_root: Path, key: str) -> Path:
    manifest_path = input_bundle_root / INPUT_BUNDLE_MANIFEST_NAME
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict):
        raise TypeError(f"Input bundle manifest must be an object: {manifest_path}")

    section = manifest.get(key)
    if not isinstance(section, dict):
        raise TypeError(f"Input bundle manifest missing section: {key}")
    value = section.get("snapshot" if key == "workspace" else "path")
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Input bundle manifest missing path: {key}")
    path = Path(value.strip())
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Input bundle manifest path must be bundle-relative: {value}")
    return input_bundle_root / path


def _optional_manifest_path(input_bundle_root: Path, key: str) -> Path | None:
    manifest_path = input_bundle_root / INPUT_BUNDLE_MANIFEST_NAME
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict):
        raise TypeError(f"Input bundle manifest must be an object: {manifest_path}")

    section = manifest.get(key)
    if section is None:
        return None
    if not isinstance(section, dict):
        raise TypeError(f"Input bundle manifest section must be an object: {key}")
    value = section.get("snapshot" if key == "workspace" else "path")
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Input bundle manifest missing path: {key}")
    path = Path(value.strip())
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Input bundle manifest path must be bundle-relative: {value}")
    return input_bundle_root / path


def read_replay_bundle_paths(input_bundle_root: Path) -> dict[str, Path]:
    paths = {
        "workspace_snapshot_tar_path": _manifest_path(input_bundle_root, "workspace"),
        "history_path": _manifest_path(input_bundle_root, "history"),
    }
    incremental_window_path = _optional_manifest_path(
        input_bundle_root,
        "incremental_window",
    )
    if incremental_window_path is not None:
        paths["incremental_window_path"] = incremental_window_path
    return paths


def restore_replay_workspace(
    *,
    input_bundle_root: Path,
    artifact_root: Path,
) -> Path:
    return restore_workspace_from_snapshot_tar(
        tar_path=_manifest_path(input_bundle_root, "workspace"),
        destination_path=artifact_root / ARTIFACT_WORKSPACE_DIR_NAME,
    )
