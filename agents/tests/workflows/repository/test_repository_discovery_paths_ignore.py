from pathlib import Path
from typing import Any

from sec_review_agents.scan_stages.discovery.stage import (
    _build_incremental_scan_manifest,
    _build_scan_manifest,
    _load_incremental_changed_files,
)


def _input_data(root: Path, paths_ignore: list[str]) -> dict[str, Any]:
    local_root = root / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-test"
    workspace.mkdir(parents=True, exist_ok=True)

    (workspace / "src").mkdir(parents=True, exist_ok=True)
    (workspace / "frontend" / "src" / "assets").mkdir(parents=True, exist_ok=True)
    (workspace / "node_modules").mkdir(parents=True, exist_ok=True)

    (workspace / "src" / "main.ts").write_text(
        "export const ok = true\n", encoding="utf-8"
    )
    (workspace / "src" / "bundle.min.js").write_text("minified\n", encoding="utf-8")
    (workspace / "frontend" / "src" / "assets" / "logo.svg").write_text(
        "<svg/>\n", encoding="utf-8"
    )
    (workspace / "node_modules" / "lib.js").write_text(
        "module.exports = {}\n", encoding="utf-8"
    )

    return {
        "run_id": "run-test",
        "input_bundle_root_path": str(local_root),
        "artifact_paths": {"discovery": str(run_artifacts / "discovery")},
        "scan_scope": {
            "max_file_bytes": 200_000,
            "paths_ignore": paths_ignore,
        },
    }


def test_paths_ignore_filters_scannable_entries(tmp_path: Path) -> None:
    input_data = _input_data(
        tmp_path,
        [
            "frontend/src/assets",
            "**/*.min.js",
            "node_modules",
        ],
    )

    entries, skipped = _build_scan_manifest(
        workspace_root=Path(input_data["input_bundle_root_path"]) / "workspace",
        scan_scope=input_data["scan_scope"],
        discovery_artifacts_path=Path(input_data["artifact_paths"]["discovery"]),
    )
    entry_paths = {item["path"] for item in entries}
    skipped_paths = {item["path"]: item["reason"] for item in skipped}

    assert entry_paths == {"src/main.ts"}
    assert skipped_paths.get("src/bundle.min.js") == "paths-ignore"
    assert skipped_paths.get("frontend/src/assets/logo.svg") == "paths-ignore"


def test_empty_paths_ignore_keeps_regular_files(tmp_path: Path) -> None:
    input_data = _input_data(tmp_path, [])

    entries, skipped = _build_scan_manifest(
        workspace_root=Path(input_data["input_bundle_root_path"]) / "workspace",
        scan_scope=input_data["scan_scope"],
        discovery_artifacts_path=Path(input_data["artifact_paths"]["discovery"]),
    )
    entry_paths = {item["path"] for item in entries}
    skipped_paths = {item["path"]: item["reason"] for item in skipped}

    assert "src/main.ts" in entry_paths
    assert "src/bundle.min.js" in entry_paths
    assert "node_modules/lib.js" not in skipped_paths


def test_incremental_scan_manifest_scans_only_changed_files(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    run_artifacts = local_root / "artifacts" / "run-test"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "src").mkdir(parents=True, exist_ok=True)
    (workspace / "docs").mkdir(parents=True, exist_ok=True)

    (workspace / "src" / "main.ts").write_text(
        "export const ok = true\n", encoding="utf-8"
    )
    (workspace / "src" / "ignored.min.js").write_text("minified\n", encoding="utf-8")
    (workspace / "docs" / "readme.md").write_text("readme\n", encoding="utf-8")

    input_data: dict[str, Any] = {
        "run_id": "run-test",
        "input_bundle_root_path": str(local_root),
        "artifact_paths": {"discovery": str(run_artifacts / "discovery")},
        "scan_scope": {
            "max_file_bytes": 200_000,
            "paths_ignore": ["**/*.min.js"],
            "incremental_changed_files": [
                {
                    "path": "src/main.ts",
                    "status": "modified",
                    "previous_path": None,
                },
                {
                    "path": "src/ignored.min.js",
                    "status": "modified",
                    "previous_path": None,
                },
                {
                    "path": "src/deleted.ts",
                    "status": "deleted",
                    "previous_path": None,
                },
            ],
        },
    }

    entries, skipped = _build_incremental_scan_manifest(
        workspace_root=Path(input_data["input_bundle_root_path"]) / "workspace",
        scan_scope=input_data["scan_scope"],
        changed_files=_load_incremental_changed_files(input_data["scan_scope"]),
        discovery_artifacts_path=Path(input_data["artifact_paths"]["discovery"]),
    )
    entry_paths = {item["path"] for item in entries}
    skipped_reasons = {item["path"]: item["reason"] for item in skipped}

    assert entry_paths == {"src/main.ts"}
    assert skipped_reasons.get("src/ignored.min.js") == "paths-ignore"
    assert "src/deleted.ts" not in skipped_reasons
