import io
import shutil
import subprocess
import tarfile
import uuid
from pathlib import Path

from sec_review_agents.filesystem.command_output import combine_command_output
from sec_review_agents.filesystem.docker_runtime import default_docker_bin
from sec_review_agents.workspace.tar_filters import workspace_tar_filter


class PatchevalWorkspaceSeedError(RuntimeError):
    """Raised when a PatchEval workspace cannot be materialized from an image."""


def _extract_tar_stream_to_dir(*, tar_stream: bytes, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(tar_stream), mode="r:") as archive:
        archive.extractall(path=destination, filter=workspace_tar_filter)


def _normalize_single_root_directory(*, extraction_root: Path) -> Path:
    children = [child for child in extraction_root.iterdir()]
    if len(children) != 1 or not children[0].is_dir():
        raise PatchevalWorkspaceSeedError(
            f"Expected a single extracted root directory in {extraction_root}, got: "
            f"{', '.join(sorted(child.name for child in children)) or '<empty>'}"
        )
    return children[0]


def _run_docker_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [default_docker_bin(), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        output = combine_command_output(result.stdout, result.stderr)
        raise PatchevalWorkspaceSeedError(output or f"docker {' '.join(args)} failed")
    return result


def _copy_archive_from_container(*, container_name: str, container_path: str) -> bytes:
    result = subprocess.run(
        [default_docker_bin(), "cp", f"{container_name}:{container_path}", "-"],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        output = combine_command_output(
            result.stdout.decode(errors="replace"),
            result.stderr.decode(errors="replace"),
        )
        raise PatchevalWorkspaceSeedError(
            output
            or f"Path '{container_path}' was not found in container '{container_name}'."
        )
    return result.stdout


def extract_dir_from_image(
    *,
    image_name: str,
    container_path: str,
    host_path: str | Path,
) -> Path:
    """
    Extract a directory from a Docker image into a host directory.

    The extracted archive is unpacked using Python 3.12's tar safety filter
    to prevent path traversal outside the destination root.
    """
    destination = Path(host_path).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    container_name = f"patcheval-seed-{uuid.uuid4().hex[:12]}"
    container_created = False
    try:
        try:
            _run_docker_command(
                ["create", "--name", container_name, "--entrypoint", "true", image_name]
            )
            container_created = True
        except PatchevalWorkspaceSeedError as error:
            raise PatchevalWorkspaceSeedError(
                f"Unable to create container from image '{image_name}'. Ensure Docker is running, the image is available locally, and the current user can access Docker. Docker said: {error}"
            ) from error

        tar_bytes = _copy_archive_from_container(
            container_name=container_name,
            container_path=container_path,
        )
        try:
            _extract_tar_stream_to_dir(tar_stream=tar_bytes, destination=destination)
        except tarfile.FilterError as error:
            raise PatchevalWorkspaceSeedError(
                f"Unsafe tar archive members were blocked while extracting '{container_path}' from '{image_name}': {error}"
            ) from error
        except tarfile.TarError as error:
            raise PatchevalWorkspaceSeedError(
                f"Failed to unpack archive for '{container_path}' from '{image_name}': {error}"
            ) from error

        return destination
    except PatchevalWorkspaceSeedError:
        raise
    except Exception as error:  # noqa: BLE001
        raise PatchevalWorkspaceSeedError(
            f"Unexpected error while extracting '{container_path}' from '{image_name}': {error}"
        ) from error
    finally:
        if container_created:
            try:
                _run_docker_command(["rm", "-f", container_name])
            except PatchevalWorkspaceSeedError:
                pass


def materialize_patcheval_workspace(
    *,
    image_name: str,
    work_dir: str,
    destination_root: str | Path,
) -> Path:
    """
    Materialize the repository workspace from a PatchEval image.

    The target `work_dir` is extracted into `destination_root`, then normalized
    so the returned path is the actual repository root on the host.
    """
    destination_root = Path(destination_root).resolve()
    if destination_root.exists():
        shutil.rmtree(destination_root)
    destination_root.mkdir(parents=True, exist_ok=True)

    extract_dir_from_image(
        image_name=image_name,
        container_path=work_dir,
        host_path=destination_root,
    )
    extracted_repo_root = _normalize_single_root_directory(
        extraction_root=destination_root
    )
    temp_repo_root = destination_root.parent / f"{destination_root.name}.__repo_tmp__"
    if temp_repo_root.exists():
        shutil.rmtree(temp_repo_root)
    extracted_repo_root.rename(temp_repo_root)
    for child in temp_repo_root.iterdir():
        shutil.move(str(child), str(destination_root / child.name))
    shutil.rmtree(temp_repo_root)
    inherited_git_dir = destination_root / ".git"
    if inherited_git_dir.exists():
        shutil.rmtree(inherited_git_dir)
    return destination_root
