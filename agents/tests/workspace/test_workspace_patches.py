import base64
import os
import subprocess

import pytest

from sec_review_agents.workspace.patches import (
    build_patch_artifact,
    normalize_declared_changed_files,
    observe_workspace_changed_files,
)


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


def test_normalize_declared_changed_files_preserves_declared_prefix() -> None:
    # A declared path may legitimately start with a top-level a/ or b/ directory;
    # the git diff prefixes must not be stripped from declared paths, or an agent
    # that edits a/x.py and declares a/x.py would silently target x.py instead.
    assert normalize_declared_changed_files(["a/src/app.py", "src/app.py"]) == [
        "a/src/app.py",
        "src/app.py",
    ]


def test_normalize_declared_changed_files_rejects_empty_path() -> None:
    with pytest.raises(ValueError, match="must name repository files"):
        normalize_declared_changed_files(["/workspace"])


def test_normalize_declared_changed_files_strips_only_absolute_workspace_prefix() -> (
    None
):
    # `/workspace/...` is the unambiguous workspace-root spelling and is stripped;
    # a relative `workspace/...` may be a real top-level `workspace/` directory and
    # must not be retargeted.
    assert normalize_declared_changed_files(["/workspace/src/app.py"]) == ["src/app.py"]
    assert normalize_declared_changed_files(["workspace/src/app.py"]) == [
        "workspace/src/app.py"
    ]


def test_observe_workspace_changed_files_reports_spaced_and_mode_only_paths(
    tmp_path,
) -> None:
    """Observation reads NUL-separated paths from Git, so it reports spaced
    names, ` b/` substrings, and mode-only changes that patch-text parsing could
    not recover reliably.
    """
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"a b.txt": "x\n", "foo b/bar.txt": "x\n"})

    # Mode-only change on the spaced path + content change on the ` b/` path.
    (workspace / "a b.txt").chmod(0o755)
    (workspace / "foo b" / "bar.txt").write_text("y\n", encoding="utf-8")

    assert sorted(observe_workspace_changed_files(workspace)) == [
        "a b.txt",
        "foo b/bar.txt",
    ]


def test_build_patch_artifact_requires_explicit_include_paths(tmp_path) -> None:
    with pytest.raises(TypeError, match="include_paths"):
        # Intentionally omit include_paths to verify the public helper fails
        # loudly when callers do not choose an explicit patch scope.
        build_patch_artifact(tmp_path)  # type: ignore[call-arg]


@pytest.mark.parametrize("name", ["a*.txt", "a[1].txt", ":(glob)*.txt", "workspace"])
@pytest.mark.parametrize("tracked", [True, False])
def test_patch_scope_uses_literal_git_paths(tmp_path, name, tracked) -> None:
    workspace = tmp_path / "workspace"
    files = {"abc.txt": "old"}
    if tracked:
        files[name] = "old"
    _init_git_repo(workspace, files)
    (workspace / name).write_text("selected")
    (workspace / "abc.txt").write_text("unselected")
    artifact = build_patch_artifact(workspace, include_paths=[name])
    assert [change["path"] for change in artifact.file_changes] == [name]
    change = artifact.file_changes[0]
    assert change["status"] == "upsert"
    assert change["content"] == "selected"
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        cwd=workspace,
        check=True,
        capture_output=True,
        text=True,
    )
    assert staged.stdout == ""


@pytest.mark.parametrize("name", [" spaced.txt", "spaced.txt ", r"a\b.txt"])
def test_patch_rejects_unpublishable_names_without_retargeting(tmp_path, name) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {name: "old", "spaced.txt": "old"})
    (workspace / name).write_text("updated")
    with pytest.raises(ValueError, match="Unsupported repository file path"):
        build_patch_artifact(workspace, include_paths=[name])


@pytest.mark.parametrize(
    "target", ["target", "missing", "../outside", "/absolute/missing"]
)
def test_patch_exports_link_target_not_target_contents(tmp_path, target) -> None:
    workspace = tmp_path / "workspace"
    _init_git_repo(workspace, {"target": "do not dereference"})
    (workspace / "link").symlink_to(target)
    artifact = build_patch_artifact(workspace, include_paths=["link"])
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
    artifact = build_patch_artifact(workspace, include_paths=["entry"])
    change = artifact.file_changes[0]
    assert change["status"] == "upsert"
    assert change.get("mode") == ("120000" if final_link else "100644")
    assert change["content"] == ("new-target" if final_link else "regular content")
    (workspace / "entry").unlink()
    assert build_patch_artifact(workspace, include_paths=["entry"]).file_changes == [
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
    artifact = build_patch_artifact(
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
        build_patch_artifact(workspace, include_paths=["link"])
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

    artifact = build_patch_artifact(workspace, include_paths=["foo", "foo/bar"])
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

    artifact = build_patch_artifact(workspace, include_paths=["foo", "foo/bar"])
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
