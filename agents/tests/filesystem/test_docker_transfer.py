import os
import subprocess
import sys
from pathlib import Path

from sec_review_agents.filesystem.docker_transfer_ops import docker_transfer_script


def _run_transfer(
    *, operation: str, root: Path, parts: tuple[str, ...], content: bytes = b""
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [
            sys.executable,
            "-c",
            docker_transfer_script(
                operation=operation,
                root=str(root),
                relative_parts=parts,
            ),
        ],
        input=content,
        capture_output=True,
        check=False,
    )


def test_transfer_script_round_trips_binary_content(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    content = bytes(range(256)) * 8

    upload = _run_transfer(
        operation="upload",
        root=root,
        parts=("nested", "payload.bin"),
        content=content,
    )
    download = _run_transfer(
        operation="download",
        root=root,
        parts=("nested", "payload.bin"),
    )

    assert upload.returncode == 0
    assert download.returncode == 0
    assert download.stdout == content


def test_transfer_script_rejects_symlink_parent(tmp_path: Path) -> None:
    """The container helper must not cross its selected route through a symlink."""
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_bytes(b"secret")
    (root / "link").symlink_to(outside, target_is_directory=True)

    download = _run_transfer(
        operation="download",
        root=root,
        parts=("link", "secret.txt"),
    )
    upload = _run_transfer(
        operation="upload",
        root=root,
        parts=("link", "secret.txt"),
        content=b"overwritten",
    )

    assert download.returncode == 1
    assert b"SEC_REVIEW_TRANSFER_ERROR:permission_denied" in download.stderr
    assert upload.returncode == 1
    assert b"SEC_REVIEW_TRANSFER_ERROR:permission_denied" in upload.stderr
    assert (outside / "secret.txt").read_bytes() == b"secret"


def test_transfer_script_rejects_fifo_without_waiting(tmp_path: Path) -> None:
    """Special files must fail promptly instead of blocking a transfer worker."""
    root = tmp_path / "root"
    root.mkdir()
    fifo = root / "pipe"
    os.mkfifo(fifo)

    download = _run_transfer(operation="download", root=root, parts=("pipe",))
    upload = _run_transfer(
        operation="upload",
        root=root,
        parts=("pipe",),
        content=b"payload",
    )

    assert download.returncode == 1
    assert upload.returncode == 1
    assert b"SEC_REVIEW_TRANSFER_ERROR:permission_denied" in download.stderr
    assert b"SEC_REVIEW_TRANSFER_ERROR:permission_denied" in upload.stderr
