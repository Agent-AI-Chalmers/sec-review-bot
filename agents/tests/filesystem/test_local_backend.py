from pathlib import Path

import pytest

from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend


@pytest.mark.parametrize("directory", [False, True])
@pytest.mark.asyncio
async def test_read_only_delete_rejects_sync_and_async(tmp_path: Path, directory: bool):
    target = tmp_path / "target"
    if directory:
        target.mkdir()
        (target / "file").write_text("keep")
    else:
        target.write_text("keep")
    backend = LocalFilesystemBackend(tmp_path, writable=False)
    assert backend.delete("/target").error
    assert (await backend.adelete("/target")).error
    assert target.exists()


@pytest.mark.parametrize("path", ["/link", "/link/file"])
def test_delete_does_not_follow_symlinks(tmp_path: Path, path: str):
    target = tmp_path / "target"
    target.mkdir()
    (target / "file").write_text("keep")
    (tmp_path / "link").symlink_to(target, target_is_directory=True)
    result = LocalFilesystemBackend(tmp_path).delete(path)
    assert result.error
    assert (target / "file").read_text() == "keep"
    assert (tmp_path / "link").is_symlink()


def test_writable_delete_removes_regular_directory(tmp_path: Path):
    (tmp_path / "target").mkdir()
    (tmp_path / "target/file").write_text("remove")
    assert LocalFilesystemBackend(tmp_path).delete("/target").error is None
    assert not (tmp_path / "target").exists()


@pytest.mark.asyncio
async def test_read_only_mount_rejects_all_mutations(tmp_path: Path):
    path = tmp_path / "file"
    path.write_text("keep")
    backend = LocalFilesystemBackend(tmp_path, writable=False)
    assert backend.write("/file", "change").error
    assert backend.edit("/file", "keep", "change").error
    assert backend.upload_files([("/file", b"change")])[0].error
    assert (await backend.awrite("/file", "change")).error
    assert (await backend.aedit("/file", "keep", "change")).error
    assert (await backend.aupload_files([("/file", b"change")]))[0].error
    assert path.read_text() == "keep"


def test_local_read_and_edit_follow_upstream(tmp_path: Path):
    path = tmp_path / "file"
    path.write_bytes(b"old\r\n")
    backend = LocalFilesystemBackend(tmp_path)
    result = backend.read("/file")
    assert result.file_data == {"content": "old\n", "encoding": "utf-8"}
    assert backend.edit("/file", "old\n", "new\n").error is None
    assert path.read_bytes() == b"new\n"
