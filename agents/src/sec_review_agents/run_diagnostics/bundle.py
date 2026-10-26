"""Build, publish, and materialize the authoritative artifact for one review run."""

import json
import os
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sec_review_agents.artifacts.archive import extract_archive
from sec_review_agents.artifacts.materialize import materialize_artifact
from sec_review_agents.artifacts.object_storage import publish_immutable_s3_artifact
from sec_review_agents.artifacts.reference import (
    ARCHIVE_MEDIA_TYPE,
    ArtifactReference,
    local_artifact_reference,
    require_artifact_media_type,
)
from sec_review_agents.artifacts.tar_zstd import validate_restricted_pax_archive
from sec_review_agents.contract_versions import RUN_DIAGNOSTIC_ARTIFACT_VERSION
from sec_review_agents.runtime.transcripts import TRANSCRIPT_SUFFIX

DIAGNOSTIC_BUNDLE_FILENAME = (
    f"diagnostic-tree.{RUN_DIAGNOSTIC_ARTIFACT_VERSION}.tar.zst"
)
DIAGNOSTIC_BUNDLE_MANIFEST = "manifest.json"
DIAGNOSTIC_BUNDLE_MANIFEST_VERSION = 1
DIAGNOSTIC_TREE_DIR = "artifact-tree"
MAX_DIAGNOSTIC_BUNDLE_BYTES = 1024 * 1024 * 1024
MAX_DIAGNOSTIC_BUNDLE_ENTRIES = 100_000
MAX_EXTRACTED_DIAGNOSTIC_BYTES = 8 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class DiagnosticReviewUnit:
    unit_id: str
    transcript_root: Path


@dataclass(frozen=True)
class MaterializedTranscriptUnit:
    unit_id: str
    transcript_paths: tuple[Path, ...]


@dataclass(frozen=True)
class PublishedDiagnosticBundle:
    reference: ArtifactReference
    unit_ids: tuple[str, ...]


def diagnostic_bundle_s3_key(run_id: str) -> str:
    _validate_path_component(run_id, label="run_id")
    return f"runs/{run_id}/artifacts/{DIAGNOSTIC_BUNDLE_FILENAME}"


def _validate_path_component(value: str, *, label: str) -> str:
    if not value or value in {".", ".."} or Path(value).name != value:
        raise ValueError(f"Diagnostic bundle {label} must be one path component.")
    return value


def publish_run_diagnostic_bundle(
    *,
    run_id: str,
    artifact_root: Path,
    review_units: list[DiagnosticReviewUnit],
    result: dict[str, Any],
    remote: bool = True,
) -> PublishedDiagnosticBundle:
    """Archive one complete review run and optionally publish it to object storage."""
    _validate_path_component(run_id, label="run_id")
    artifact_root = artifact_root.resolve()
    output_dir = artifact_root / "published"
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = (output_dir / DIAGNOSTIC_BUNDLE_FILENAME).resolve()
    manifest_units = _manifest_units(artifact_root, review_units)

    temporary_archive = _temporary_archive_path(output_dir)
    try:
        _build_diagnostic_archive(
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

    if remote:
        reference = publish_immutable_s3_artifact(
            reference,
            key=diagnostic_bundle_s3_key(run_id),
            description="run diagnostic bundle",
        )
    return PublishedDiagnosticBundle(
        reference=reference,
        unit_ids=tuple(str(unit["id"]) for unit in manifest_units),
    )


def _temporary_archive_path(output_dir: Path) -> Path:
    # mkstemp creates the archive 0600; hard-linking preserves that owner-only
    # mode at the published path because diagnostics contain transcripts.
    descriptor, value = tempfile.mkstemp(
        prefix=f".{DIAGNOSTIC_BUNDLE_FILENAME}.", suffix=".tmp", dir=output_dir
    )
    os.close(descriptor)
    return Path(value)


def _build_diagnostic_archive(
    archive_path: Path,
    *,
    artifact_root: Path,
    manifest_units: list[dict[str, Any]],
    result: dict[str, Any],
    run_id: str,
) -> None:
    with tempfile.TemporaryDirectory(prefix="sec-review-diagnostic-bundle-") as tempdir:
        manifest_path = Path(tempdir) / DIAGNOSTIC_BUNDLE_MANIFEST
        manifest_path.write_text(
            json.dumps(
                {
                    "version": DIAGNOSTIC_BUNDLE_MANIFEST_VERSION,
                    "run_id": run_id,
                    "result": "result.json",
                    "review_units": manifest_units,
                },
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        result_path = Path(tempdir) / "result.json"
        result_path.write_text(
            json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with tarfile.open(
            archive_path, mode="w:zst", format=tarfile.PAX_FORMAT
        ) as archive:
            archive.add(
                manifest_path,
                arcname=DIAGNOSTIC_BUNDLE_MANIFEST,
                filter=_normalize_tar_info,
            )
            archive.add(
                result_path,
                arcname="result.json",
                filter=_normalize_tar_info,
            )
            _add_artifact_tree(archive, artifact_root)
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
                "Existing run diagnostic bundle differs from immutable publication."
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
    review_units: list[DiagnosticReviewUnit],
) -> list[dict[str, Any]]:
    manifest_units: list[dict[str, Any]] = []
    seen_unit_ids: set[str] = set()
    for unit in review_units:
        _validate_path_component(unit.unit_id, label="unit_id")
        if unit.unit_id in seen_unit_ids:
            raise ValueError(
                f"Diagnostic bundle review unit is duplicated: {unit.unit_id}"
            )
        seen_unit_ids.add(unit.unit_id)
        transcript_root = unit.transcript_root.resolve()
        try:
            transcript_root.relative_to(artifact_root)
        except ValueError as error:
            raise ValueError(
                "Diagnostic bundle transcript root must be inside artifact root."
            ) from error
        transcript_paths = [
            f"{DIAGNOSTIC_TREE_DIR}/{path.relative_to(artifact_root).as_posix()}"
            for path in sorted(transcript_root.glob(f"*{TRANSCRIPT_SUFFIX}"))
            if path.is_file()
        ]
        if transcript_paths:
            manifest_units.append({"id": unit.unit_id, "transcripts": transcript_paths})
    return manifest_units


def _add_artifact_tree(archive: tarfile.TarFile, artifact_root: Path) -> None:
    archive.add(
        artifact_root,
        arcname=DIAGNOSTIC_TREE_DIR,
        recursive=False,
        filter=_normalize_tar_info,
    )
    for path in sorted(artifact_root.rglob("*")):
        relative = path.relative_to(artifact_root)
        if relative.parts[0] == "published" or path.is_symlink():
            continue
        archive.add(
            path,
            arcname=f"{DIAGNOSTIC_TREE_DIR}/{relative.as_posix()}",
            recursive=False,
            filter=_normalize_tar_info,
        )


def _normalize_tar_info(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """Remove host- and attempt-specific metadata from archive members."""
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    return info


def materialize_diagnostic_transcript_unit(
    reference: ArtifactReference,
    *,
    run_id: str,
    unit_id: str,
    destination: Path,
) -> MaterializedTranscriptUnit:
    require_artifact_media_type(reference, ARCHIVE_MEDIA_TYPE)
    archive_path = materialize_artifact(
        reference,
        destination.with_suffix(".tar.zst"),
        maximum_size=MAX_DIAGNOSTIC_BUNDLE_BYTES,
        expected_s3_key=(
            diagnostic_bundle_s3_key(run_id)
            if urlparse(reference.uri).scheme == "s3"
            else None
        ),
    )
    root = extract_archive(
        archive_path,
        destination,
        maximum_entries=MAX_DIAGNOSTIC_BUNDLE_ENTRIES,
        maximum_extracted_bytes=MAX_EXTRACTED_DIAGNOSTIC_BYTES,
    )
    units = _validate_materialized_bundle(root, run_id=run_id)
    for current_unit_id, transcript_paths in units.items():
        if current_unit_id == unit_id:
            return MaterializedTranscriptUnit(
                unit_id=unit_id,
                transcript_paths=transcript_paths,
            )
    raise ValueError(f"Diagnostic review unit not found: {unit_id}")


def _validate_materialized_bundle(
    root: Path, *, run_id: str
) -> dict[str, tuple[Path, ...]]:
    try:
        manifest = json.loads(
            (root / DIAGNOSTIC_BUNDLE_MANIFEST).read_text(encoding="utf-8")
        )
        json.loads((root / "result.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Diagnostic bundle JSON documents are invalid.") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("version") != DIAGNOSTIC_BUNDLE_MANIFEST_VERSION
        or manifest.get("run_id") != run_id
        or manifest.get("result") != "result.json"
    ):
        raise ValueError(
            "Diagnostic bundle manifest does not match extraction request."
        )
    units = manifest.get("review_units")
    if not isinstance(units, list):
        raise ValueError("Diagnostic bundle manifest has no review units.")
    resolved_root = root.resolve()
    validated: dict[str, tuple[Path, ...]] = {}
    for unit in units:
        if not isinstance(unit, dict):
            raise ValueError("Diagnostic review unit is invalid.")
        current_unit_id = unit.get("id")
        paths = unit.get("transcripts")
        if (
            not isinstance(current_unit_id, str)
            or not current_unit_id
            or current_unit_id in validated
            or not isinstance(paths, list)
            or not paths
        ):
            raise ValueError("Diagnostic review unit is invalid.")
        resolved_paths: list[Path] = []
        for value in paths:
            if not isinstance(value, str) or not _is_transcript_manifest_path(value):
                raise ValueError("Diagnostic manifest path is invalid.")
            path = (root / value).resolve()
            try:
                path.relative_to(resolved_root)
            except ValueError as error:
                raise ValueError("Diagnostic manifest path escapes bundle.") from error
            if not path.is_file() or path.suffix != TRANSCRIPT_SUFFIX:
                raise ValueError(f"Diagnostic bundle file is missing: {value}")
            resolved_paths.append(path)
        validated[current_unit_id] = tuple(resolved_paths)
    return validated


def _is_transcript_manifest_path(value: str) -> bool:
    parts = value.split("/")
    return (
        "\\" not in value
        and len(parts) > 1
        and parts[0] == DIAGNOSTIC_TREE_DIR
        and all(part not in {"", ".", ".."} for part in parts)
        and value.endswith(TRANSCRIPT_SUFFIX)
    )


__all__ = [
    "DiagnosticReviewUnit",
    "MaterializedTranscriptUnit",
    "PublishedDiagnosticBundle",
    "diagnostic_bundle_s3_key",
    "materialize_diagnostic_transcript_unit",
    "publish_run_diagnostic_bundle",
]
