import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from pydantic import BaseModel

from sec_review_agents.workspace.file_changes import FileChange
from sec_review_agents.workspace.paths import validate_repository_file_path
from sec_review_agents.workspace.snapshots import restore_workspace_from_snapshot_tar


def apply_workspace_patch(workspace_path: Path, patch_content: str | None) -> None:
    """Reconstruct delivery paths in a disposable stage workspace using Git.

    The committed code wins over snapshot drift, including untracked files and
    directories blocking delivery paths. Reconstruction may remove those blockers
    recursively; unrelated environment files remain. The immutable source snapshot
    is never modified. An independent index preserves the workspace's real index
    and HEAD, and applies the patch against committed code rather than disk state.
    """
    if not patch_content or not patch_content.strip():
        return
    if not (workspace_path / ".git").exists():
        raise RuntimeError("Patch reconstruction requires a workspace repository root.")

    with tempfile.TemporaryDirectory(prefix="sec-review-patch-index-") as tempdir:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(tempdir) / "index"))

        def git(*args: str, data: bytes | None = None) -> bytes:
            process = subprocess.run(
                ["git", *args],
                cwd=workspace_path,
                env=env,
                input=data,
                capture_output=True,
                check=False,
            )
            if process.returncode:
                raise RuntimeError(
                    process.stderr.decode("utf-8", errors="replace").strip()
                    or "Git patch reconstruction failed."
                )
            return process.stdout

        git("read-tree", "HEAD")
        # Repository apply.whitespace=fix must not rewrite committed repair bytes.
        git(
            "apply",
            "--cached",
            "--whitespace=nowarn",
            "-p1",
            data=patch_content.encode("utf-8"),
        )
        fields = git(
            "diff",
            "--cached",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            "--ignore-submodules=none",
            "-z",
            "HEAD",
        ).split(b"\x00")
        deletes: list[str] = []
        upserts: list[tuple[str, bytes, bytes]] = []
        for metadata, raw_path in zip(fields[0:-1:2], fields[1::2], strict=True):
            _, mode, _, oid, status = metadata.split()
            path = validate_repository_file_path(raw_path.decode("utf-8"))
            if status == b"D":
                deletes.append(path)
            elif mode in {b"100644", b"100755", b"120000"}:
                upserts.append((path, mode, oid))
            else:
                raise ValueError(f"Unsupported patch entry: {path}")

        # Delete deepest paths first. If snapshot drift puts a symlink in a
        # deleted path's parents, remove that blocker instead of traversing it.
        for path in sorted(deletes, key=lambda value: value.count("/"), reverse=True):
            relative = Path(path)
            blocked = False
            for parent in reversed(relative.parents):
                if parent == Path("."):
                    continue
                ancestor = workspace_path / parent
                if ancestor.is_symlink():
                    ancestor.unlink()
                    blocked = True
                    break
            if blocked:
                continue
            target = workspace_path / relative
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)

        # Checkout would run smudge filters and newline/encoding conversions.
        # Materialize raw blobs so reconstructed bytes match published contents,
        # without executing repository-configured checkout filters on the host.
        for path, mode, oid in upserts:
            content = git("cat-file", "blob", oid.decode("ascii"))
            _restore_file(workspace_path, path, mode, content)


def _restore_file(workspace_path: Path, path: str, mode: bytes, content: bytes) -> None:
    """Restore a validated delivery entry, replacing snapshot blockers in its path."""
    relative = Path(path)
    # Never follow snapshot symlinks, even in parent directories. Force
    # replacement is limited to blockers along validated delivery paths.
    for parent in reversed(relative.parents):
        if parent == Path("."):
            continue
        ancestor = workspace_path / parent
        if ancestor.is_symlink() or (ancestor.exists() and not ancestor.is_dir()):
            ancestor.unlink()
        ancestor.mkdir(exist_ok=True)
    target = workspace_path / relative
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)
    if mode == b"120000":
        os.symlink(content, os.fsencode(target))
    else:
        # Exclusive creation also prevents following a link installed at
        # the destination after blocker removal; chmod restores Git mode
        # independently of the process umask or the old snapshot mode.
        with target.open("xb") as output:
            output.write(content)
            os.fchmod(output.fileno(), 0o755 if mode == b"100755" else 0o644)


def check_workspace_patch_applies_to_fresh_baseline(
    workspace_snapshot_tar_path: Path,
    patch_content: str,
) -> str | None:
    """Probe the same reconstruction used by verification on a disposable seed."""
    if not patch_content or not patch_content.strip():
        return None
    with tempfile.TemporaryDirectory(prefix="sec-review-patch-apply-") as tempdir:
        fresh_workspace = Path(tempdir) / "workspace"
        restore_workspace_from_snapshot_tar(
            tar_path=workspace_snapshot_tar_path,
            destination_path=fresh_workspace,
        )
        try:
            apply_workspace_patch(fresh_workspace, patch_content)
        except (RuntimeError, ValueError) as error:
            return str(error)
    return None


class PatchArtifact(BaseModel):
    """Diff and final file contents exported from one committed tree.

    The diff describes the change from the baseline; file changes carry the
    resulting blobs and modes. Both representations must describe the same change.
    """

    patch_diff: str
    file_changes: list[FileChange]
