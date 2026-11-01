import base64
import os
import stat

import pytest

from sec_review_agents.workspace.file_changes import collect_publishable_file_changes


def test_collect_publishable_file_changes_reads_temp_workspace_before_cleanup(
    tmp_path,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "src").mkdir()
    (workspace / "src" / "app.py").write_text("print('fixed')\n", encoding="utf-8")
    (workspace / "image.bin").write_bytes(b"\x00\x01")
    (workspace / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    (workspace / "run.sh").chmod((workspace / "run.sh").stat().st_mode | stat.S_IXUSR)

    file_changes = collect_publishable_file_changes(
        workspace,
        ["src/app.py", "image.bin", "run.sh", "src/deleted.py"],
    )

    assert file_changes == [
        {
            "path": "src/app.py",
            "status": "upsert",
            "mode": "100644",
            "content": "print('fixed')\n",
            "content_encoding": "utf-8",
        },
        {
            "path": "image.bin",
            "status": "upsert",
            "mode": "100644",
            "content": "AAE=",
            "content_encoding": "base64",
        },
        {
            "path": "run.sh",
            "status": "upsert",
            "mode": "100755",
            "content": "#!/bin/sh\n",
            "content_encoding": "utf-8",
        },
        {
            "path": "src/deleted.py",
            "status": "deleted",
        },
    ]


def test_export_link_preserves_non_utf8_target_bytes(tmp_path) -> None:
    os.symlink(b"target-\xff", os.fsencode(tmp_path / "link"))
    change = collect_publishable_file_changes(tmp_path, ["link"])[0]
    assert change["status"] == "upsert"
    assert change.get("mode") == "120000"
    assert change["content_encoding"] == "base64"
    assert base64.b64decode(change["content"]) == b"target-\xff"


def test_export_rejects_symlink_parent(tmp_path) -> None:
    (tmp_path / "real").mkdir()
    (tmp_path / "real" / "file").write_text("content")
    (tmp_path / "alias").symlink_to("real")
    with pytest.raises(ValueError, match="traverses a symbolic link"):
        collect_publishable_file_changes(tmp_path, ["alias/file"])


@pytest.mark.parametrize("name", [" name", "name ", r"a\b"])
def test_export_rejects_noncanonical_git_names(tmp_path, name) -> None:
    with pytest.raises(ValueError, match="Unsupported repository file path"):
        collect_publishable_file_changes(tmp_path, [name])


def test_export_rejects_directory_without_git_deletion(tmp_path) -> None:
    (tmp_path / "directory").mkdir()
    with pytest.raises(ValueError, match="not a file or symbolic link"):
        collect_publishable_file_changes(tmp_path, ["directory"])
