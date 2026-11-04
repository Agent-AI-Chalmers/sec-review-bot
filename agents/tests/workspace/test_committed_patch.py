import subprocess
from pathlib import Path

import pytest

from sec_review_agents.workspace.commits import (
    build_committed_patch,
    resolve_workspace_commit,
)
from sec_review_agents.workspace.patches import (
    check_workspace_patch_applies_to_fresh_baseline,
)
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def commit(repo: Path) -> str:
    git(
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "--allow-empty",
        "-m",
        "repair",
    )
    return resolve_workspace_commit(repo)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    git(workspace, "init")
    (workspace / "app.txt").write_text("before\n")
    git(workspace, "add", ".")
    commit(workspace)
    return workspace


def test_exports_all_commits_and_ignores_index_and_worktree(
    repo: Path, tmp_path: Path
) -> None:
    """Publishing must reproduce the reviewed commit even when the same file drifts."""
    baseline = resolve_workspace_commit(repo)
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    (repo / "app.txt").write_text("committed\n")
    git(repo, "add", "app.txt")
    commit(repo)
    (repo / "test.txt").write_text("regression\n")
    git(repo, "add", "test.txt")
    commit(repo)
    (repo / "app.txt").write_text("staged noise\n")
    git(repo, "add", "app.txt")
    (repo / "app.txt").write_text("unstaged noise\n")
    (repo / "scratch").write_text("noise")
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    assert {c["path"]: c.get("content") for c in artifact.file_changes} == {
        "app.txt": "committed\n",
        "test.txt": "regression\n",
    }
    assert (
        check_workspace_patch_applies_to_fresh_baseline(snapshot, artifact.patch_diff)
        is None
    )


def test_no_commit_means_no_patch(repo: Path) -> None:
    baseline = resolve_workspace_commit(repo)
    (repo / "app.txt").write_text("uncommitted")
    git(repo, "add", ".")
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    assert artifact.patch_diff == ""
    assert artifact.file_changes == []


def test_exports_deletion_binary_symlink_and_mode_from_commit(repo: Path) -> None:
    baseline = resolve_workspace_commit(repo)
    (repo / "app.txt").unlink()
    (repo / "binary").write_bytes(b"\x00\xff")
    (repo / "link").symlink_to("missing-target")
    (repo / "executable").write_text("hello\n")
    (repo / "executable").chmod(0o755)
    git(repo, "add", "-A")
    commit(repo)
    (repo / "link").unlink()
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    changes = {c["path"]: c for c in artifact.file_changes}
    assert changes["app.txt"] == {"path": "app.txt", "status": "deleted"}
    assert changes["link"].get("mode") == "120000"
    assert changes["link"].get("content") == "missing-target"
    assert changes["executable"].get("mode") == "100755"
    assert changes["binary"].get("content") == "AP8="


def test_rejects_replaced_history(repo: Path) -> None:
    baseline = resolve_workspace_commit(repo)
    git(repo, "checkout", "--orphan", "unrelated")
    (repo / "app.txt").write_text("unrelated history")
    git(repo, "add", ".")
    commit(repo)
    with pytest.raises(RuntimeError):
        build_committed_patch(repo, baseline_commit=baseline)


def test_commits_only_selected_hunk(repo: Path) -> None:
    baseline = resolve_workspace_commit(repo)
    (repo / "app.txt").write_text("selected\n")
    git(repo, "add", "app.txt")
    (repo / "app.txt").write_text("selected\nlocal experiment\n")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    assert artifact.file_changes[0].get("content") == "selected\n"


def test_mode_only_change_preserves_spaced_path(repo: Path) -> None:
    (repo / "space b name").write_text("same\n")
    git(repo, "add", ".")
    baseline = commit(repo)
    (repo / "space b name").chmod(0o755)
    git(repo, "add", ".")
    commit(repo)
    git(repo, "config", "color.ui", "always")
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    assert artifact.file_changes == [
        {
            "path": "space b name",
            "status": "upsert",
            "mode": "100755",
            "content": "same\n",
            "content_encoding": "utf-8",
        }
    ]
    assert "\x1b[" not in artifact.patch_diff


def test_rename_exports_delete_and_final_blob(repo: Path) -> None:
    baseline = resolve_workspace_commit(repo)
    git(repo, "mv", "app.txt", "renamed.txt")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    assert artifact.file_changes == [
        {"path": "app.txt", "status": "deleted"},
        {
            "path": "renamed.txt",
            "status": "upsert",
            "mode": "100644",
            "content": "before\n",
            "content_encoding": "utf-8",
        },
    ]
    assert "rename from" not in artifact.patch_diff


def test_raw_diff_preserves_tab_and_unicode_paths(repo: Path) -> None:
    baseline = resolve_workspace_commit(repo)
    name = "目录/tab\tfile"
    (repo / "目录").mkdir()
    (repo / name).write_text("committed bytes\n")
    git(repo, "add", ".")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    assert artifact.file_changes == [
        {
            "path": name,
            "status": "upsert",
            "mode": "100644",
            "content": "committed bytes\n",
            "content_encoding": "utf-8",
        }
    ]


@pytest.mark.parametrize("ignore_submodules", ["none", "all"])
def test_rejects_gitlink_in_committed_tree(repo: Path, ignore_submodules: str) -> None:
    """A submodule commit cannot be published as a regular file blob."""
    baseline = resolve_workspace_commit(repo)
    git(repo, "config", "diff.ignoreSubmodules", ignore_submodules)
    git(repo, "update-index", "--add", "--cacheinfo", "160000", baseline, "submodule")
    commit(repo)
    with pytest.raises(ValueError, match="Unsupported committed entry: submodule"):
        build_committed_patch(repo, baseline_commit=baseline)


def test_reconstruction_overwrites_snapshot_drift(repo: Path, tmp_path: Path) -> None:
    """Committed code takes precedence over tracked edits present only in the seed."""
    baseline = resolve_workspace_commit(repo)
    (repo / "app.txt").write_text("snapshot-only edit\n")
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    (repo / "app.txt").write_text("committed repair\n")
    git(repo, "add", ".")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    assert (
        check_workspace_patch_applies_to_fresh_baseline(snapshot, artifact.patch_diff)
        is None
    )


@pytest.mark.parametrize(
    "preexisting", [False, True], ids=["new-file", "snapshot-file"]
)
@pytest.mark.parametrize("ignored", [False, True], ids=["untracked", "ignored"])
@pytest.mark.parametrize("modify_existing", [False, True], ids=["unchanged", "edited"])
@pytest.mark.parametrize("do_commit", [False, True], ids=["add-only", "committed"])
def test_added_untracked_file_against_original_snapshot(
    repo: Path,
    tmp_path: Path,
    preexisting: bool,
    ignored: bool,
    do_commit: bool,
    modify_existing: bool,
) -> None:
    """Committed additions replace snapshot files; add-only edits stay excluded."""
    from sec_review_agents.workspace.patches import apply_workspace_patch
    from sec_review_agents.workspace.snapshots import (
        restore_workspace_from_snapshot_tar,
    )

    name = "local.txt"
    if ignored:
        (repo / ".gitignore").write_text(f"{name}\n")
        git(repo, "add", ".gitignore")
        commit(repo)
    baseline = resolve_workspace_commit(repo)
    if preexisting:
        (repo / name).write_text("original untracked content\n")
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)

    expected_content = (
        "agent content\n"
        if not preexisting or modify_existing
        else "original untracked content\n"
    )
    (repo / name).write_text(expected_content)
    git(repo, "add", "-f", name)
    assert resolve_workspace_commit(repo) == baseline
    if do_commit:
        commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    error = check_workspace_patch_applies_to_fresh_baseline(
        snapshot, artifact.patch_diff
    )
    verifier = tmp_path / "verifier"
    restore_workspace_from_snapshot_tar(tar_path=snapshot, destination_path=verifier)

    if not do_commit:
        assert artifact.file_changes == []
        assert artifact.patch_diff == ""
    else:
        assert artifact.file_changes == [
            {
                "path": name,
                "status": "upsert",
                "mode": "100644",
                "content": expected_content,
                "content_encoding": "utf-8",
            }
        ]
    assert error is None
    apply_workspace_patch(workspace_path=verifier, patch_content=artifact.patch_diff)
    if do_commit:
        assert (verifier / name).read_text() == expected_content
    elif preexisting:
        assert (verifier / name).read_text() == "original untracked content\n"
    else:
        assert not (verifier / name).exists()


@pytest.mark.parametrize(
    "transition", ["file-to-dir", "dir-to-file", "dir-to-link", "link-to-dir", "delete"]
)
def test_reconstruction_forces_delivery_paths_and_preserves_real_index(
    repo: Path, tmp_path: Path, transition: str
) -> None:
    """Blockers in a disposable verifier are expendable; unrelated files and index are not."""
    from sec_review_agents.workspace.patches import apply_workspace_patch
    from sec_review_agents.workspace.snapshots import (
        restore_workspace_from_snapshot_tar,
    )

    if transition in {"dir-to-file", "dir-to-link"}:
        (repo / "entry").mkdir()
        (repo / "entry/child").write_text("old")
    elif transition == "link-to-dir":
        (repo / "entry").symlink_to("missing")
    else:
        (repo / "entry").write_text("old")
    git(repo, "add", ".")
    baseline = commit(repo)
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    if (repo / "entry").is_dir():
        (repo / "entry/child").unlink()
        (repo / "entry").rmdir()
    else:
        (repo / "entry").unlink()
    if transition.endswith("to-dir"):
        (repo / "entry").mkdir()
        (repo / "entry/child").write_text("repair")
    elif transition == "dir-to-link":
        (repo / "entry").symlink_to("missing-target")
    elif transition != "delete":
        (repo / "entry").write_text("repair")
    git(repo, "add", "-A")
    target = commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    verifier = tmp_path / "verifier"
    restore_workspace_from_snapshot_tar(tar_path=snapshot, destination_path=verifier)
    (verifier / "environment").write_text("keep")
    git(verifier, "add", "environment")
    original_index = (verifier / ".git/index").read_bytes()
    if transition.startswith("dir-to"):
        (verifier / "entry/cache").write_text("expendable cache")
    apply_workspace_patch(verifier, artifact.patch_diff)
    assert (verifier / ".git/index").read_bytes() == original_index
    assert resolve_workspace_commit(verifier) == baseline
    assert (verifier / "environment").read_text() == "keep"
    if transition == "delete":
        assert not (verifier / "entry").exists()
    elif transition == "dir-to-link":
        assert (verifier / "entry").is_symlink()
        assert (verifier / "entry").readlink() == Path("missing-target")
    elif transition.endswith("to-dir"):
        assert (verifier / "entry/child").read_text() == "repair"
    else:
        assert (verifier / "entry").read_text() == "repair"
    # Compare all delivered entries to the target tree using an independent index.
    git(verifier, "reset", "--", "environment")
    git(verifier, "add", "-A", "--", "entry")
    expected_tree = git(repo, "rev-parse", f"{target}^{{tree}}")
    assert git(verifier, "write-tree") == expected_tree


@pytest.mark.parametrize("delete_child", [False, True])
def test_reconstruction_never_traverses_symlink_parent(
    repo: Path, tmp_path: Path, delete_child: bool
) -> None:
    from sec_review_agents.workspace.patches import apply_workspace_patch
    from sec_review_agents.workspace.snapshots import (
        restore_workspace_from_snapshot_tar,
    )

    (repo / "dir").mkdir()
    (repo / "dir/file").write_text("old")
    git(repo, "add", ".")
    baseline = commit(repo)
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    if delete_child:
        (repo / "dir/file").unlink()
    else:
        (repo / "dir/file").write_text("repair")
    git(repo, "add", "-A")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    verifier = tmp_path / "verifier"
    restore_workspace_from_snapshot_tar(tar_path=snapshot, destination_path=verifier)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "file").write_text("external sentinel")
    (verifier / "dir/file").unlink()
    (verifier / "dir").rmdir()
    (verifier / "dir").symlink_to(outside)
    apply_workspace_patch(verifier, artifact.patch_diff)
    assert (outside / "file").read_text() == "external sentinel"
    if delete_child:
        assert not (verifier / "dir/file").exists()
    else:
        assert not (verifier / "dir").is_symlink()
        assert (verifier / "dir/file").read_text() == "repair"


def test_reconstruction_preserves_binary_mode_and_link_bytes(
    repo: Path, tmp_path: Path
) -> None:
    from sec_review_agents.workspace.patches import apply_workspace_patch
    from sec_review_agents.workspace.snapshots import (
        restore_workspace_from_snapshot_tar,
    )

    baseline = resolve_workspace_commit(repo)
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    (repo / "app.txt").write_bytes(b"\x00\xff\r\n")
    (repo / "app.txt").chmod(0o755)
    (repo / "link").symlink_to("../missing")
    git(repo, "add", ".")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    verifier = tmp_path / "verifier"
    restore_workspace_from_snapshot_tar(tar_path=snapshot, destination_path=verifier)
    apply_workspace_patch(verifier, artifact.patch_diff)
    assert (verifier / "app.txt").read_bytes() == b"\x00\xff\r\n"
    assert (verifier / "app.txt").stat().st_mode & 0o111
    assert (verifier / "link").readlink() == Path("../missing")


def test_reconstruction_does_not_fix_committed_whitespace(
    repo: Path, tmp_path: Path
) -> None:
    from sec_review_agents.workspace.patches import apply_workspace_patch
    from sec_review_agents.workspace.snapshots import (
        restore_workspace_from_snapshot_tar,
    )

    baseline = resolve_workspace_commit(repo)
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    (repo / "app.txt").write_bytes(b"repair  \n")
    git(repo, "add", ".")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    verifier = tmp_path / "verifier"
    restore_workspace_from_snapshot_tar(tar_path=snapshot, destination_path=verifier)
    git(verifier, "config", "apply.whitespace", "fix")
    apply_workspace_patch(verifier, artifact.patch_diff)
    assert (verifier / "app.txt").read_bytes() == b"repair  \n"


def test_reconstruction_preserves_link_type_despite_checkout_config(
    repo: Path, tmp_path: Path
) -> None:
    from sec_review_agents.workspace.patches import apply_workspace_patch
    from sec_review_agents.workspace.snapshots import (
        restore_workspace_from_snapshot_tar,
    )

    baseline = resolve_workspace_commit(repo)
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    (repo / "link").symlink_to("../missing")
    git(repo, "add", ".")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    verifier = tmp_path / "verifier"
    restore_workspace_from_snapshot_tar(tar_path=snapshot, destination_path=verifier)
    git(verifier, "config", "core.symlinks", "false")
    apply_workspace_patch(verifier, artifact.patch_diff)
    assert (verifier / "link").is_symlink()
    assert (verifier / "link").readlink() == Path("../missing")


@pytest.mark.parametrize("conversion", ["smudge", "autocrlf", "attributes-eol"])
def test_reconstruction_uses_published_blobs_without_checkout_conversion(
    repo: Path, tmp_path: Path, conversion: str
) -> None:
    """Reconstruction must preserve published bytes and never run checkout filters."""
    from sec_review_agents.workspace.patches import apply_workspace_patch
    from sec_review_agents.workspace.snapshots import (
        restore_workspace_from_snapshot_tar,
    )

    attributes = {
        "smudge": "app.txt filter=alter\n",
        "autocrlf": "",
        "attributes-eol": "app.txt text eol=crlf\n",
    }
    (repo / ".gitattributes").write_text(attributes[conversion])
    git(repo, "add", ".")
    baseline = commit(repo)
    snapshot = tmp_path / "baseline.tar"
    create_workspace_snapshot_tar(workspace_path=repo, tar_path=snapshot)
    (repo / "app.txt").write_bytes(b"NEW\n")
    git(repo, "add", ".")
    commit(repo)
    artifact = build_committed_patch(repo, baseline_commit=baseline)
    published = next(
        change for change in artifact.file_changes if change["path"] == "app.txt"
    )
    assert published["status"] == "upsert"
    assert published["content"] == "NEW\n"
    verifier = tmp_path / "verifier"
    restore_workspace_from_snapshot_tar(tar_path=snapshot, destination_path=verifier)
    if conversion == "smudge":
        git(
            verifier,
            "config",
            "filter.alter.smudge",
            "touch filter-ran; sed s/NEW/ALTERED/g",
        )
        git(verifier, "config", "filter.alter.required", "true")
    elif conversion == "autocrlf":
        git(verifier, "config", "core.autocrlf", "true")
    apply_workspace_patch(verifier, artifact.patch_diff)
    assert (verifier / "app.txt").read_bytes() == published["content"].encode("utf-8")
    assert not (verifier / "filter-ran").exists()
