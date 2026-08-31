import subprocess
from pathlib import Path

import pytest

from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
    restore_workspace_from_snapshot_tar,
)


def _init_git_workspace(workspace: Path) -> None:
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "src").mkdir()
    (workspace / "src" / "app.py").write_text("print('ok')\n", encoding="utf-8")
    subprocess.run(
        ["git", "init"], cwd=workspace, check=True, capture_output=True, text=True
    )
    subprocess.run(
        ["git", "config", "user.name", "test"],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "add", "--all", "."],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "commit", "-m", "snapshot"],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    )


def test_snapshot_tar_restore_preserves_git_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "local" / "workspace"
    _init_git_workspace(workspace)

    tar_path = tmp_path / "local" / "artifacts" / "run-1" / WORKSPACE_SNAPSHOT_TAR_NAME
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=tar_path)

    restored = tmp_path / "restored" / "workspace-copy"
    restore_workspace_from_snapshot_tar(tar_path=tar_path, destination_path=restored)

    assert (restored / "src" / "app.py").exists()
    assert (restored / ".git").is_dir()
    head = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"],
        cwd=restored,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head


def test_materialized_restore_prefers_snapshot_tar_over_live_workspace(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    _init_git_workspace(workspace)

    tar_path = local_root / "artifacts" / "run-1" / WORKSPACE_SNAPSHOT_TAR_NAME
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=tar_path)
    (workspace / "src" / "app.py").write_text(
        "print('changed after tar')\n", encoding="utf-8"
    )

    restored = tmp_path / "restored" / "workspace-copy"
    restore_workspace_from_snapshot_tar(
        tar_path=tar_path,
        destination_path=restored,
    )

    assert (restored / "src" / "app.py").read_text(encoding="utf-8") == (
        "print('ok')\n"
    )


def test_snapshot_tar_restore_preserves_absolute_symlink_fixture(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "local" / "workspace"
    _init_git_workspace(workspace)
    fixture_dir = workspace / "internal/third_party/dep/fs/testdata/symlinks"
    fixture_dir.mkdir(parents=True)
    (fixture_dir / "invalid-symlink").symlink_to("/tmp/invalid-target")

    tar_path = tmp_path / "local" / "artifacts" / "run-1" / WORKSPACE_SNAPSHOT_TAR_NAME
    create_workspace_snapshot_tar(workspace_path=workspace, tar_path=tar_path)

    restored = tmp_path / "restored" / "workspace-copy"
    restore_workspace_from_snapshot_tar(tar_path=tar_path, destination_path=restored)

    symlink_path = (
        restored / "internal/third_party/dep/fs/testdata/symlinks/invalid-symlink"
    )
    assert symlink_path.is_symlink()
    assert symlink_path.readlink() == Path("/tmp/invalid-target")


def test_snapshot_restore_requires_existing_snapshot_tar(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    workspace = local_root / "workspace"
    _init_git_workspace(workspace)
    (workspace / "src" / "app.py").write_text("print('fallback')\n", encoding="utf-8")

    with pytest.raises(FileNotFoundError):
        restore_workspace_from_snapshot_tar(
            tar_path=local_root / "workspace.snapshot.tar",
            destination_path=tmp_path / "restored" / "workspace-copy",
        )
