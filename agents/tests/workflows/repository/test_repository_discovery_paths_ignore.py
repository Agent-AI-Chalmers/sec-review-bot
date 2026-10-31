from pathlib import Path
from typing import Any

import pytest

from sec_review_agents.scan_stages.discovery.stage import (
    _build_incremental_scan_manifest,
    _build_scan_manifest,
)
from sec_review_agents.scan_stages.input import RepositoryScanScope


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
        "scan_scope": RepositoryScanScope(
            paths_ignore=paths_ignore, incremental_changed_files=[]
        ),
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
    entry_paths = {item.path for item in entries}
    skipped_paths = {item.path: item.reason for item in skipped}

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
    entry_paths = {item.path for item in entries}
    skipped_paths = {item.path: item.reason for item in skipped}

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

    input_data["scan_scope"] = RepositoryScanScope.model_validate(
        input_data["scan_scope"]
    )
    entries, skipped = _build_incremental_scan_manifest(
        workspace_root=Path(input_data["input_bundle_root_path"]) / "workspace",
        scan_scope=input_data["scan_scope"],
        discovery_artifacts_path=Path(input_data["artifact_paths"]["discovery"]),
    )
    entry_paths = {item.path for item in entries}
    skipped_reasons = {item.path: item.reason for item in skipped}

    assert entry_paths == {"src/main.ts"}
    assert skipped_reasons.get("src/ignored.min.js") == "paths-ignore"
    assert "src/deleted.ts" not in skipped_reasons


def test_incremental_discovery_rejects_a_status_outside_the_contract(
    tmp_path: Path,
) -> None:
    """A status the contract does not define must stop discovery, not be guessed at.

    `removed` is the compare API's word for a deletion. When it reached discovery the file was
    scanned instead of skipped, because only `deleted` is recognized as gone -- and nothing
    reported the mismatch. Failing here names the disagreement.
    """
    input_data = _input_data(tmp_path, [])
    workspace = Path(input_data["input_bundle_root_path"]) / "workspace"

    with pytest.raises(ValueError, match="status"):
        _build_incremental_scan_manifest(
            workspace_root=workspace,
            scan_scope=RepositoryScanScope.model_validate(
                {
                    "paths_ignore": [],
                    "incremental_changed_files": [
                        {
                            "path": "src/app.ts",
                            "status": "removed",
                            "previous_path": None,
                        }
                    ],
                }
            ),
            discovery_artifacts_path=Path(input_data["artifact_paths"]["discovery"]),
        )


def test_incremental_discovery_skips_a_deleted_file(tmp_path: Path) -> None:
    """`deleted` is the one status that removes a file from discovery."""
    input_data = _input_data(tmp_path, [])
    workspace = Path(input_data["input_bundle_root_path"]) / "workspace"
    (workspace / "src" / "gone.ts").write_text("export const gone = 1\n", "utf8")

    input_data["scan_scope"] = RepositoryScanScope.model_validate(
        input_data["scan_scope"]
    )
    entries, skipped = _build_incremental_scan_manifest(
        workspace_root=workspace,
        scan_scope=RepositoryScanScope.model_validate(
            {
                "paths_ignore": [],
                "incremental_changed_files": [
                    {"path": "src/gone.ts", "status": "deleted", "previous_path": None}
                ],
            }
        ),
        discovery_artifacts_path=Path(input_data["artifact_paths"]["discovery"]),
    )

    assert entries == []
    assert skipped == []


@pytest.mark.parametrize("changed_paths", [[], [" src\\main.ts ", "src/main.ts"]])
def test_incremental_scope_preserves_discovery_path_normalization(
    tmp_path, changed_paths
):
    input_data = _input_data(tmp_path, [])
    scope = RepositoryScanScope.model_validate(
        {
            "paths_ignore": [],
            "incremental_changed_files": [
                {"path": path, "status": "modified", "previous_path": None}
                for path in changed_paths
            ],
        }
    )
    entries, skipped = _build_incremental_scan_manifest(
        workspace_root=Path(input_data["input_bundle_root_path"]) / "workspace",
        scan_scope=scope,
        discovery_artifacts_path=tmp_path / "artifacts",
    )
    assert [item.path for item in entries] == (["src/main.ts"] if changed_paths else [])
    assert skipped == []
