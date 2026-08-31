import shutil
import tarfile
import tempfile
from pathlib import Path

from sec_review_agents.workspace.tar_filters import workspace_tar_filter

WORKSPACE_SNAPSHOT_TAR_NAME = "workspace.snapshot.tar"
ARTIFACT_WORKSPACE_DIR_NAME = "workspace"


def create_workspace_snapshot_tar(
    *,
    workspace_path: Path,
    tar_path: Path,
) -> Path:
    """Create the immutable restore seed for mutable stage workspaces."""
    if not workspace_path.is_dir():
        raise ValueError(f"Workspace path is not a directory: {workspace_path}")

    tar_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=tar_path.parent,
        prefix=f".{tar_path.name}.",
        suffix=".tmp",
        delete=False,
    ) as temp_file:
        temp_path = Path(temp_file.name)

    try:
        with tarfile.open(temp_path, mode="w") as archive:
            archive.add(workspace_path, arcname=workspace_path.name, recursive=True)
        temp_path.replace(tar_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise

    return tar_path


def restore_workspace_from_snapshot_tar(
    *,
    tar_path: Path,
    destination_path: Path,
) -> Path:
    if not tar_path.is_file():
        raise FileNotFoundError(f"Workspace snapshot tar not found: {tar_path}")

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        dir=destination_path.parent,
        prefix=f".{destination_path.name}.extract-",
    ) as temp_dir:
        temp_root = Path(temp_dir)
        with tarfile.open(tar_path, mode="r") as archive:
            archive.extractall(temp_root, filter=workspace_tar_filter)

        extracted_workspace = temp_root / "workspace"
        if not extracted_workspace.is_dir():
            children = [child for child in temp_root.iterdir() if child.is_dir()]
            if len(children) == 1:
                extracted_workspace = children[0]
            else:
                raise ValueError(
                    f"Workspace snapshot tar does not contain a single workspace root: {tar_path}"
                )

        shutil.rmtree(destination_path, ignore_errors=True)
        shutil.move(str(extracted_workspace), str(destination_path))

    return destination_path
