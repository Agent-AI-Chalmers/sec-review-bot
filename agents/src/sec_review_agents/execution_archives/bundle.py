"""Build, publish, and materialize the authoritative artifact for one review run."""

import json
import os
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from sec_review_agents.artifacts.archive import extract_archive
from sec_review_agents.artifacts.materialize import (
    materialize_verified_artifact_file,
)
from sec_review_agents.artifacts.reference import (
    ARCHIVE_MEDIA_TYPE,
    ArtifactReference,
    local_artifact_reference,
    require_artifact_media_type,
)
from sec_review_agents.artifacts.s3_adapter import (
    publish_immutable_s3_artifact,
    read_s3_artifact_reference,
)
from sec_review_agents.artifacts.tar_zstd import (
    canonical_tar_info,
    validate_restricted_pax_archive,
)
from sec_review_agents.contract_versions import EXECUTION_ARCHIVE_ARTIFACT_VERSION
from sec_review_agents.runtime.trajectories import TRAJECTORY_SUFFIX

EXECUTION_ARCHIVE_FILENAME = (
    f"execution-archive.{EXECUTION_ARCHIVE_ARTIFACT_VERSION}.tar.zst"
)
EXECUTION_ARCHIVE_MANIFEST = "manifest.json"
EXECUTION_ARCHIVE_MANIFEST_VERSION = 1
ARCHIVE_TREE_DIR = "artifact-tree"
MAX_EXECUTION_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_EXECUTION_ARCHIVE_ENTRIES = 100_000
MAX_EXTRACTED_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class ArchiveReviewUnit:
    unit_id: str
    trajectory_root: Path


@dataclass(frozen=True)
class MaterializedTrajectoryUnit:
    unit_id: str
    trajectory_paths: tuple[Path, ...]


@dataclass(frozen=True)
class ExecutionArchive:
    reference: ArtifactReference
    unit_ids: tuple[str, ...]


def execution_archive_s3_key(run_id: str) -> str:
    _validate_path_component(run_id, label="run_id")
    return f"runs/{run_id}/artifacts/{EXECUTION_ARCHIVE_FILENAME}"


def _validate_path_component(value: str, *, label: str) -> str:
    if not value or value in {".", ".."} or Path(value).name != value:
        raise ValueError(f"Execution archive {label} must be one path component.")
    return value


def publish_execution_archive(
    *,
    run_id: str,
    artifact_root: Path,
    review_units: list[ArchiveReviewUnit],
    result: dict[str, Any],
    destination_scheme: Literal["file", "s3"] = "s3",
) -> ExecutionArchive:
    """Archive one complete review run and publish it through the selected scheme."""
    if destination_scheme not in {"file", "s3"}:
        raise ValueError(f"Unsupported execution archive scheme: {destination_scheme}")
    _validate_path_component(run_id, label="run_id")
    if destination_scheme == "s3":
        recovered = _recover_s3_publication(
            run_id=run_id,
            artifact_root=artifact_root,
            review_units=review_units,
            result=result,
        )
        if recovered is not None:
            return recovered
    artifact_root = artifact_root.resolve()
    output_dir = artifact_root / "published"
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = (output_dir / EXECUTION_ARCHIVE_FILENAME).resolve()
    manifest_units = _manifest_units(artifact_root, review_units)

    temporary_archive = _temporary_archive_path(output_dir)
    try:
        _build_execution_archive(
            temporary_archive,
            artifact_root=artifact_root,
            manifest_units=manifest_units,
            result=result,
            run_id=run_id,
        )
        reference = _install_immutable_file_archive(
            local_artifact_reference(temporary_archive),
            temporary_archive=temporary_archive,
            destination=archive_path,
        )
    finally:
        if temporary_archive.exists():
            temporary_archive.unlink()
            _fsync_directory(output_dir)

    if destination_scheme == "s3":
        reference = publish_immutable_s3_artifact(
            reference,
            key=execution_archive_s3_key(run_id),
            description="execution archive",
        )
    return ExecutionArchive(
        reference=reference,
        unit_ids=tuple(str(unit["id"]) for unit in manifest_units),
    )


def _recover_s3_publication(
    *,
    run_id: str,
    artifact_root: Path,
    review_units: list[ArchiveReviewUnit],
    result: dict[str, Any],
) -> ExecutionArchive | None:
    # Use request paths without inspecting the lost worker's filesystem. The
    # immutable archive, not a new glob over local trajectories, owns its unit IDs.
    request_root = Path(os.path.abspath(artifact_root))
    relative_units: list[ArchiveReviewUnit] = []
    seen: set[str] = set()
    for unit in review_units:
        _validate_path_component(unit.unit_id, label="unit_id")
        if unit.unit_id in seen:
            raise ValueError(
                f"Execution archive review unit is duplicated: {unit.unit_id}"
            )
        seen.add(unit.unit_id)
        try:
            relative_root = Path(os.path.abspath(unit.trajectory_root)).relative_to(
                request_root
            )
        except ValueError as error:
            raise ValueError(
                "Execution archive trajectory root must be inside artifact root."
            ) from error
        relative_units.append(ArchiveReviewUnit(unit.unit_id, relative_root))

    key = execution_archive_s3_key(run_id)
    reference = read_s3_artifact_reference(key=key)
    if reference is None:
        return None
    require_artifact_media_type(reference, ARCHIVE_MEDIA_TYPE)
    with tempfile.TemporaryDirectory(prefix="sec-review-archive-recovery-") as tempdir:
        recovery_root = Path(tempdir)
        archive = materialize_verified_artifact_file(
            reference,
            local_destination=recovery_root / EXECUTION_ARCHIVE_FILENAME,
            maximum_bytes=MAX_EXECUTION_ARCHIVE_BYTES,
            expected_s3_key=key,
        )
        root = extract_archive(
            archive,
            recovery_root / "bundle",
            maximum_entries=MAX_EXECUTION_ARCHIVE_ENTRIES,
            maximum_extracted_bytes=MAX_EXTRACTED_ARCHIVE_BYTES,
        )
        units = _validate_materialized_bundle(root, run_id=run_id)
        stored_result = json.loads((root / "result.json").read_text(encoding="utf-8"))
        if json.dumps(
            stored_result, sort_keys=True, separators=(",", ":")
        ) != json.dumps(result, sort_keys=True, separators=(",", ":")):
            raise ValueError(
                "Existing execution archive result does not match publication request."
            )
        tree = root / ARCHIVE_TREE_DIR
        if not tree.is_dir():
            raise ValueError("Existing execution archive artifact tree is missing.")
        expected_units = _manifest_units(
            tree,
            [
                ArchiveReviewUnit(unit.unit_id, tree / unit.trajectory_root)
                for unit in relative_units
            ],
        )
        manifest = json.loads(
            (root / EXECUTION_ARCHIVE_MANIFEST).read_text(encoding="utf-8")
        )
        if manifest["review_units"] != expected_units:
            raise ValueError(
                "Existing execution archive review units do not match publication request."
            )
    return ExecutionArchive(reference=reference, unit_ids=tuple(units))


def _temporary_archive_path(output_dir: Path) -> Path:
    # mkstemp creates the archive 0600; hard-linking preserves that owner-only
    # mode at the published path because the archive contains trajectories.
    descriptor, value = tempfile.mkstemp(
        prefix=f".{EXECUTION_ARCHIVE_FILENAME}.", suffix=".tmp", dir=output_dir
    )
    os.close(descriptor)
    return Path(value)


def _build_execution_archive(
    archive_path: Path,
    *,
    artifact_root: Path,
    manifest_units: list[dict[str, Any]],
    result: dict[str, Any],
    run_id: str,
) -> None:
    manifest_bytes = (
        json.dumps(
            {
                "version": EXECUTION_ARCHIVE_MANIFEST_VERSION,
                "run_id": run_id,
                "result": "result.json",
                "review_units": manifest_units,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode()
    result_bytes = (
        json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()
    # The archive is authoritative, so exceeding its contract is an error rather than a
    # reason to silently omit files. Reuse this scan for archive construction so the budget and
    # the emitted entry set cannot drift within one publication attempt.
    artifact_paths = _artifact_tree_paths(artifact_root)
    entry_count = 3 + len(artifact_paths)
    if entry_count > MAX_EXECUTION_ARCHIVE_ENTRIES:
        raise ValueError("Execution archive exceeds the entry count limit.")
    extracted_bytes = (
        len(manifest_bytes)
        + len(result_bytes)
        + sum(path.stat().st_size for path in artifact_paths if path.is_file())
    )
    if extracted_bytes > MAX_EXTRACTED_ARCHIVE_BYTES:
        raise ValueError("Execution archive exceeds the extracted size limit.")

    with tempfile.TemporaryDirectory(prefix="sec-review-execution-archive-") as tempdir:
        manifest_path = Path(tempdir) / EXECUTION_ARCHIVE_MANIFEST
        manifest_path.write_bytes(manifest_bytes)
        result_path = Path(tempdir) / "result.json"
        result_path.write_bytes(result_bytes)
        with tarfile.open(
            archive_path, mode="w:zst", format=tarfile.PAX_FORMAT
        ) as archive:
            archive.add(
                manifest_path,
                arcname=EXECUTION_ARCHIVE_MANIFEST,
                filter=canonical_tar_info,
            )
            archive.add(
                result_path,
                arcname="result.json",
                filter=canonical_tar_info,
            )
            _add_artifact_tree(archive, artifact_root, artifact_paths)
    if archive_path.stat().st_size > MAX_EXECUTION_ARCHIVE_BYTES:
        raise ValueError("Execution archive exceeds the compressed size limit.")
    validate_restricted_pax_archive(archive_path)
    with archive_path.open("rb") as archive_file:
        os.fsync(archive_file.fileno())


def _install_immutable_file_archive(
    reference: ArtifactReference,
    *,
    temporary_archive: Path,
    destination: Path,
) -> ArtifactReference:
    try:
        os.link(temporary_archive, destination)
    except FileExistsError:
        existing = local_artifact_reference(destination)
        if (
            existing.digest != reference.digest
            or existing.size_bytes != reference.size_bytes
        ):
            raise RuntimeError(
                "Existing execution archive differs from immutable publication."
            ) from None
    else:
        _fsync_directory(destination.parent)
    return ArtifactReference(
        uri=destination.as_uri(),
        digest=reference.digest,
        media_type=reference.media_type,
        size_bytes=reference.size_bytes,
    )


def _fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _manifest_units(
    artifact_root: Path,
    review_units: list[ArchiveReviewUnit],
) -> list[dict[str, Any]]:
    manifest_units: list[dict[str, Any]] = []
    seen_unit_ids: set[str] = set()
    for unit in review_units:
        _validate_path_component(unit.unit_id, label="unit_id")
        if unit.unit_id in seen_unit_ids:
            raise ValueError(
                f"Execution archive review unit is duplicated: {unit.unit_id}"
            )
        seen_unit_ids.add(unit.unit_id)
        trajectory_root = unit.trajectory_root.resolve()
        try:
            trajectory_root.relative_to(artifact_root)
        except ValueError as error:
            raise ValueError(
                "Execution archive trajectory root must be inside artifact root."
            ) from error
        trajectory_paths = [
            f"{ARCHIVE_TREE_DIR}/{path.relative_to(artifact_root).as_posix()}"
            for path in sorted(trajectory_root.glob(f"*{TRAJECTORY_SUFFIX}"))
            if path.is_file()
        ]
        if trajectory_paths:
            manifest_units.append(
                {"id": unit.unit_id, "trajectories": trajectory_paths}
            )
    return manifest_units


def _artifact_tree_paths(artifact_root: Path) -> list[Path]:
    return [
        path
        for path in sorted(artifact_root.rglob("*"))
        if path.relative_to(artifact_root).parts[0] != "published"
        and not path.is_symlink()
    ]


def _add_artifact_tree(
    archive: tarfile.TarFile, artifact_root: Path, artifact_paths: list[Path]
) -> None:
    archive.add(
        artifact_root,
        arcname=ARCHIVE_TREE_DIR,
        recursive=False,
        filter=canonical_tar_info,
    )
    for path in artifact_paths:
        relative = path.relative_to(artifact_root)
        archive.add(
            path,
            arcname=f"{ARCHIVE_TREE_DIR}/{relative.as_posix()}",
            recursive=False,
            filter=canonical_tar_info,
        )


def materialize_archive_trajectory_unit(
    reference: ArtifactReference,
    *,
    run_id: str,
    unit_id: str,
    destination: Path,
) -> MaterializedTrajectoryUnit:
    require_artifact_media_type(reference, ARCHIVE_MEDIA_TYPE)
    archive_path = materialize_verified_artifact_file(
        reference,
        local_destination=destination.with_suffix(".tar.zst"),
        maximum_bytes=MAX_EXECUTION_ARCHIVE_BYTES,
        expected_s3_key=(
            execution_archive_s3_key(run_id)
            if urlparse(reference.uri).scheme == "s3"
            else None
        ),
    )
    root = extract_archive(
        archive_path,
        destination,
        maximum_entries=MAX_EXECUTION_ARCHIVE_ENTRIES,
        maximum_extracted_bytes=MAX_EXTRACTED_ARCHIVE_BYTES,
    )
    units = _validate_materialized_bundle(root, run_id=run_id)
    for current_unit_id, trajectory_paths in units.items():
        if current_unit_id == unit_id:
            return MaterializedTrajectoryUnit(
                unit_id=unit_id,
                trajectory_paths=trajectory_paths,
            )
    raise ValueError(f"Archive review unit not found: {unit_id}")


def _validate_materialized_bundle(
    root: Path, *, run_id: str
) -> dict[str, tuple[Path, ...]]:
    try:
        manifest = json.loads(
            (root / EXECUTION_ARCHIVE_MANIFEST).read_text(encoding="utf-8")
        )
        json.loads((root / "result.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Execution archive JSON documents are invalid.") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("version") != EXECUTION_ARCHIVE_MANIFEST_VERSION
        or manifest.get("run_id") != run_id
        or manifest.get("result") != "result.json"
    ):
        raise ValueError("Execution archive manifest does not match the requested run.")
    units = manifest.get("review_units")
    if not isinstance(units, list):
        raise ValueError("Execution archive manifest has no review units.")
    resolved_root = root.resolve()
    validated: dict[str, tuple[Path, ...]] = {}
    for unit in units:
        if not isinstance(unit, dict):
            raise ValueError("Archive review unit is invalid.")
        current_unit_id = unit.get("id")
        paths = unit.get("trajectories")
        if (
            not isinstance(current_unit_id, str)
            or not current_unit_id
            or current_unit_id in validated
            or not isinstance(paths, list)
            or not paths
        ):
            raise ValueError("Archive review unit is invalid.")
        resolved_paths: list[Path] = []
        for value in paths:
            if not isinstance(value, str) or not _is_trajectory_manifest_path(value):
                raise ValueError("Archive manifest path is invalid.")
            path = (root / value).resolve()
            try:
                path.relative_to(resolved_root)
            except ValueError as error:
                raise ValueError("Archive manifest path escapes bundle.") from error
            if not path.is_file() or path.suffix != TRAJECTORY_SUFFIX:
                raise ValueError(f"Execution archive file is missing: {value}")
            resolved_paths.append(path)
        validated[current_unit_id] = tuple(resolved_paths)
    return validated


def _is_trajectory_manifest_path(value: str) -> bool:
    parts = value.split("/")
    return (
        "\\" not in value
        and len(parts) > 1
        and parts[0] == ARCHIVE_TREE_DIR
        and all(part not in {"", ".", ".."} for part in parts)
        and value.endswith(TRAJECTORY_SUFFIX)
    )


__all__ = [
    "ArchiveReviewUnit",
    "ExecutionArchive",
    "MaterializedTrajectoryUnit",
    "execution_archive_s3_key",
    "materialize_archive_trajectory_unit",
    "publish_execution_archive",
]
