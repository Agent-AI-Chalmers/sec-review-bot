from pathlib import Path

import pytest

from sec_review_agents.scan_stages.discovery.stage import (
    DEFAULT_DISCOVERY_MAX_FILE_BYTES,
    _build_incremental_scan_manifest,
    _build_scan_manifest,
    _resolve_discovery_max_file_bytes,
)

EXCLUDED_EXTENSIONS = (".md", ".rst", ".txt", ".text", ".csv", ".tsv", ".log")
SCANNABLE_EXTENSIONS = (".yaml", ".yml", ".json", ".sql", ".unknown")


def _write_selection_fixture(workspace: Path) -> list[str]:
    paths = [
        *(f"excluded/file{extension}" for extension in EXCLUDED_EXTENSIONS),
        *(f"scannable/file{extension}" for extension in SCANNABLE_EXTENSIONS),
        "scannable/Dockerfile",
    ]
    for relative_path in paths:
        path = workspace / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture content\n", encoding="utf-8")
    return paths


def _scan_scope(*, paths_ignore: list[str] | None = None) -> dict[str, object]:
    return {
        "paths_ignore": paths_ignore or [],
    }


def test_full_manifest_excludes_only_denylisted_discovery_kinds(
    tmp_path: Path,
) -> None:
    """Unknown formats remain eligible so file selection does not become a language allowlist."""
    workspace = tmp_path / "workspace"
    _write_selection_fixture(workspace)

    entries, skipped = _build_scan_manifest(
        workspace_root=workspace,
        scan_scope=_scan_scope(),
        discovery_artifacts_path=tmp_path / "artifacts",
    )

    assert {item["path"] for item in entries} == {
        *(f"scannable/file{extension}" for extension in SCANNABLE_EXTENSIONS),
        "scannable/Dockerfile",
    }
    assert {item["path"]: item["reason"] for item in skipped} == {
        f"excluded/file{extension}": "excluded-discovery-kind"
        for extension in EXCLUDED_EXTENSIONS
    }


def test_incremental_manifest_uses_same_discovery_kind_policy(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    paths = _write_selection_fixture(workspace)
    changed_files = [
        {"path": path, "status": "modified", "previous_path": None} for path in paths
    ]

    entries, skipped = _build_incremental_scan_manifest(
        workspace_root=workspace,
        scan_scope=_scan_scope(),
        changed_files=changed_files,
        discovery_artifacts_path=tmp_path / "artifacts",
    )

    assert {item["path"] for item in entries} == {
        *(f"scannable/file{extension}" for extension in SCANNABLE_EXTENSIONS),
        "scannable/Dockerfile",
    }
    assert {item["path"]: item["reason"] for item in skipped} == {
        f"excluded/file{extension}": "excluded-discovery-kind"
        for extension in EXCLUDED_EXTENSIONS
    }


@pytest.mark.parametrize("incremental", [False, True])
def test_paths_ignore_takes_precedence_over_discovery_kind_policy(
    tmp_path: Path, incremental: bool
) -> None:
    """Explicit repository exclusions should not be reported as scanner policy limits."""
    workspace = tmp_path / "workspace"
    path = workspace / "docs" / "ignored.md"
    path.parent.mkdir(parents=True)
    path.write_text("ignored\n", encoding="utf-8")
    scan_scope = _scan_scope(paths_ignore=["docs"])

    if incremental:
        _, skipped = _build_incremental_scan_manifest(
            workspace_root=workspace,
            scan_scope=scan_scope,
            changed_files=[
                {
                    "path": "docs/ignored.md",
                    "status": "modified",
                    "previous_path": None,
                }
            ],
            discovery_artifacts_path=tmp_path / "artifacts",
        )
    else:
        _, skipped = _build_scan_manifest(
            workspace_root=workspace,
            scan_scope=scan_scope,
            discovery_artifacts_path=tmp_path / "artifacts",
        )

    assert skipped == [
        {
            "path": "docs/ignored.md",
            "reason": "paths-ignore",
            "size_bytes": len("ignored\n"),
        }
    ]


@pytest.mark.parametrize("incremental", [False, True])
def test_discovery_kind_policy_takes_precedence_over_size_limit(
    tmp_path: Path, incremental: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    path = workspace / "docs" / "large.md"
    path.parent.mkdir(parents=True)
    path.write_text("large document\n", encoding="utf-8")
    monkeypatch.setenv("AGENT_DISCOVERY_MAX_FILE_BYTES", "1")
    scan_scope: dict[str, object] = {"paths_ignore": []}

    if incremental:
        _, skipped = _build_incremental_scan_manifest(
            workspace_root=workspace,
            scan_scope=scan_scope,
            changed_files=[
                {
                    "path": "docs/large.md",
                    "status": "modified",
                    "previous_path": None,
                }
            ],
            discovery_artifacts_path=tmp_path / "artifacts",
        )
    else:
        _, skipped = _build_scan_manifest(
            workspace_root=workspace,
            scan_scope=scan_scope,
            discovery_artifacts_path=tmp_path / "artifacts",
        )

    assert skipped[0]["reason"] == "excluded-discovery-kind"


def test_discovery_max_file_bytes_uses_environment_or_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGENT_DISCOVERY_MAX_FILE_BYTES", raising=False)
    assert _resolve_discovery_max_file_bytes() == (
        DEFAULT_DISCOVERY_MAX_FILE_BYTES,
        "default",
    )

    monkeypatch.setenv("AGENT_DISCOVERY_MAX_FILE_BYTES", "300000")
    assert _resolve_discovery_max_file_bytes() == (
        300_000,
        "AGENT_DISCOVERY_MAX_FILE_BYTES",
    )
