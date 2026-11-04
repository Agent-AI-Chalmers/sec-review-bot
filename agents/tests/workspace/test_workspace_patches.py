import base64
import os
import subprocess

import pytest

from sec_review_agents.workspace.commits import (
    build_committed_patch,
    resolve_workspace_commit,
)


def _commit_patch(workspace, *, include_paths):
    baseline = resolve_workspace_commit(workspace)
    subprocess.run(
        ["git", "--literal-pathspecs", "add", "-A", "--", *include_paths],
        cwd=workspace,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "commit", "--allow-empty", "-qm", "repair"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )
    return build_committed_patch(workspace, baseline_commit=baseline)


def _init_git_repo(workspace, files: dict[str, str]) -> None:
    workspace.mkdir()
    for relative, content in files.items():
        path = workspace / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "t@t"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "t"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )
    subprocess.run(["git", "add", "-A"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-qm", "init"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )


@pytest.mark.parametrize("name", ["a*.txt", "a[1].txt", ":(glob)*.txt", "workspace"])
@pytest.mark.parametrize("tracked", [True, False])
def test_committed_paths_preserve_literal_git_names(tmp_path, name, tracked) -> None:
    workspace = tmp_path / "workspace"
    files = {"abc.txt": "old"}
    if tracked:
        files[name] = "old"
    _init_git_repo(workspace, files)
    (workspace / name).write_text("selected")
    (workspace / "abc.txt").write_text("unselected")
    artifact = _commit_patch(workspace, include_paths=[name])
    assert [change["path"] for change in artifact.file_changes] == [name]
    change = artifact.file_changes[0]
    assert change["status"] == "upsert"
    assert change["content"] == "selected"


@pytest.mark.parametrize("name", [" spaced.txt", "spaced.txt ", r"a\b.txt"])
def test_patch_rejects_unpublishable_names_without_retargeting(tmp_path, name) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {name: "old", "spaced.txt": "old"})
    (workspace / name).write_text("updated")
    with pytest.raises(ValueError, match="Unsupported repository file path"):
        _commit_patch(workspace, include_paths=[name])


@pytest.mark.parametrize(
    "target", ["target", "missing", "../outside", "/absolute/missing"]
)
def test_patch_exports_link_target_not_target_contents(tmp_path, target) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"target": "do not dereference"})
    (workspace / "link").symlink_to(target)
    artifact = _commit_patch(workspace, include_paths=["link"])
    assert artifact.file_changes == [
        {
            "path": "link",
            "status": "upsert",
            "mode": "120000",
            "content": target,
            "content_encoding": "utf-8",
        }
    ]
    assert "120000" in artifact.patch_diff


@pytest.mark.parametrize(
    "initial_link,final_link", [(True, True), (True, False), (False, True)]
)
def test_patch_preserves_link_edits_and_type_transitions(
    tmp_path, initial_link, final_link
) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"entry": "old"})
    if initial_link:
        (workspace / "entry").unlink()
        (workspace / "entry").symlink_to("old-target")
        subprocess.run(
            ["git", "commit", "-am", "link"],
            cwd=workspace,
            check=True,
            capture_output=True,
        )
    (workspace / "entry").unlink()
    if final_link:
        (workspace / "entry").symlink_to("new-target")
    else:
        (workspace / "entry").write_text("regular content")
    artifact = _commit_patch(workspace, include_paths=["entry"])
    change = artifact.file_changes[0]
    assert change["status"] == "upsert"
    assert change.get("mode") == ("120000" if final_link else "100644")
    assert change["content"] == ("new-target" if final_link else "regular content")
    (workspace / "entry").unlink()
    assert _commit_patch(workspace, include_paths=["entry"]).file_changes == [
        {"path": "entry", "status": "deleted"}
    ]


def test_file_changes_reproduce_git_tree_with_symlinks(tmp_path) -> None:
    """Exported blobs and modes must recreate the same tree Git sees on disk."""
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"regular": "old", "removed": "old", "to-link": "old"})
    (workspace / "regular").write_text("new")
    (workspace / "removed").unlink()
    (workspace / "to-link").unlink()
    (workspace / "to-link").symlink_to("../missing")
    os.symlink("目标", workspace / "binary-link")
    artifact = _commit_patch(
        workspace, include_paths=["regular", "removed", "to-link", "binary-link"]
    )
    env = dict(os.environ, GIT_INDEX_FILE=str(tmp_path / "publication-index"))

    def git(*args, data=None):
        return subprocess.run(
            ["git", *args],
            cwd=workspace,
            env=env,
            input=data,
            capture_output=True,
            check=True,
        ).stdout.strip()

    git("read-tree", "HEAD")
    for change in artifact.file_changes:
        if change["status"] == "deleted":
            git("update-index", "--force-remove", "--", change["path"])
            continue
        content = (
            base64.b64decode(change["content"])
            if change["content_encoding"] == "base64"
            else change["content"].encode()
        )
        blob = git("hash-object", "-w", "--stdin", data=content).decode()
        git(
            "update-index",
            "--add",
            "--cacheinfo",
            change.get("mode", "100644"),
            blob,
            change["path"],
        )
    published_tree = git("write-tree")
    git("add", "-A")
    assert published_tree == git("write-tree")


def test_patch_rejects_non_utf8_diff_without_corrupting_target(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"file": "original"})
    os.symlink(b"target-\xff", os.fsencode(workspace / "link"))
    with pytest.raises(ValueError, match="non-UTF-8"):
        _commit_patch(workspace, include_paths=["link"])
    assert os.fsencode(os.readlink(workspace / "link")) == b"target-\xff"


@pytest.mark.parametrize("initial_link", [False, True])
def test_patch_exports_file_replaced_by_directory(tmp_path, initial_link) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"foo": "old"})
    if initial_link:
        (workspace / "foo").unlink()
        (workspace / "foo").symlink_to("missing")
        subprocess.run(
            ["git", "commit", "-am", "link"],
            cwd=workspace,
            check=True,
            capture_output=True,
        )
    (workspace / "foo").unlink()
    (workspace / "foo").mkdir()
    (workspace / "foo" / "bar").write_text("new")

    artifact = _commit_patch(workspace, include_paths=["foo"])
    assert artifact.file_changes == [
        {"path": "foo", "status": "deleted"},
        {
            "path": "foo/bar",
            "status": "upsert",
            "mode": "100644",
            "content": "new",
            "content_encoding": "utf-8",
        },
    ]
    subprocess.run(
        ["git", "apply", "--reverse", "--check"],
        cwd=workspace,
        input=artifact.patch_diff,
        text=True,
        check=True,
        capture_output=True,
    )


@pytest.mark.parametrize("final_link", [False, True])
def test_patch_exports_directory_replaced_by_file(tmp_path, final_link) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"foo/bar": "old"})
    (workspace / "foo/bar").unlink()
    (workspace / "foo").rmdir()
    if final_link:
        (workspace / "foo").symlink_to("missing")
    else:
        (workspace / "foo").write_text("new")

    artifact = _commit_patch(workspace, include_paths=["foo"])
    assert artifact.file_changes == [
        {
            "path": "foo",
            "status": "upsert",
            "mode": "120000" if final_link else "100644",
            "content": "missing" if final_link else "new",
            "content_encoding": "utf-8",
        },
        {"path": "foo/bar", "status": "deleted"},
    ]
    subprocess.run(
        ["git", "apply", "--reverse", "--check"],
        cwd=workspace,
        input=artifact.patch_diff,
        text=True,
        check=True,
        capture_output=True,
    )
