"""Publish and materialize immutable run transcript bundles."""

import json
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sec_review_agents.artifacts.archive import extract_archive
from sec_review_agents.artifacts.immutable_s3 import publish_immutable_s3_artifact
from sec_review_agents.artifacts.reference import (
    ArtifactReference,
    local_artifact_reference,
    materialize_artifact,
)
from sec_review_agents.runtime.transcripts import TRANSCRIPT_SUFFIX

TRANSCRIPT_BUNDLE_FILENAME = "review-transcripts.v1.tar.zst"
TRANSCRIPT_BUNDLE_MANIFEST = "manifest.json"
MAX_TRANSCRIPT_BUNDLE_BYTES = 1024 * 1024 * 1024
MAX_TRANSCRIPT_BUNDLE_ENTRIES = 20_000
MAX_EXTRACTED_TRANSCRIPT_BYTES = 4 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class TranscriptReviewUnit:
    review_unit_id: str
    transcript_root: Path


@dataclass(frozen=True)
class MaterializedTranscriptUnit:
    review_unit_id: str
    transcript_paths: tuple[Path, ...]


def transcript_bundle_s3_key(run_id: str) -> str:
    _validate_path_component(run_id, label="run_id")
    return f"runs/{run_id}/transcripts/{TRANSCRIPT_BUNDLE_FILENAME}"


def _validate_path_component(value: str, *, label: str) -> str:
    if not value or value in {".", ".."} or Path(value).name != value:
        raise ValueError(f"Transcript bundle {label} must be one path component.")
    return value


def publish_transcript_bundle(
    *,
    run_id: str,
    artifact_root: Path,
    review_units: list[TranscriptReviewUnit],
    remote: bool = True,
) -> ArtifactReference:
    """Archive one run's review units and publish an immutable reference."""
    if not review_units:
        raise ValueError("Transcript bundle requires at least one review unit.")
    _validate_path_component(run_id, label="run_id")
    output_dir = artifact_root / "published"
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / TRANSCRIPT_BUNDLE_FILENAME
    manifest_units: list[dict[str, Any]] = []
    seen_unit_ids: set[str] = set()

    with tempfile.TemporaryDirectory(prefix="sec-review-transcript-bundle-") as tempdir:
        bundle_root = Path(tempdir) / "bundle"
        bundle_root.mkdir()
        for unit in review_units:
            _validate_path_component(unit.review_unit_id, label="review_unit_id")
            if unit.review_unit_id in seen_unit_ids:
                raise ValueError(
                    f"Transcript bundle review unit is duplicated: {unit.review_unit_id}"
                )
            seen_unit_ids.add(unit.review_unit_id)
            unit_files = sorted(unit.transcript_root.glob(f"*{TRANSCRIPT_SUFFIX}"))
            if not unit_files:
                continue
            relative_paths: list[str] = []
            unit_root = bundle_root / "transcripts" / unit.review_unit_id
            unit_root.mkdir(parents=True)
            for source in unit_files:
                target = unit_root / source.name
                target.write_bytes(source.read_bytes())
                relative_paths.append(target.relative_to(bundle_root).as_posix())
            manifest_units.append(
                {
                    "id": unit.review_unit_id,
                    "transcripts": relative_paths,
                }
            )
        if not manifest_units:
            raise ValueError("Transcript bundle contains no transcript files.")
        (bundle_root / TRANSCRIPT_BUNDLE_MANIFEST).write_text(
            json.dumps(
                {"version": 1, "run_id": run_id, "review_units": manifest_units},
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        with tarfile.open(archive_path, mode="w:zst") as archive:
            for child in sorted(bundle_root.iterdir()):
                archive.add(child, arcname=child.name, recursive=True)

    reference = local_artifact_reference(archive_path)
    if not remote:
        return reference
    key = transcript_bundle_s3_key(run_id)
    return publish_immutable_s3_artifact(
        reference,
        key=key,
        description="managed transcript bundle",
    )


def materialize_transcript_unit(
    reference: ArtifactReference,
    *,
    run_id: str,
    review_unit_id: str,
    destination: Path,
) -> MaterializedTranscriptUnit:
    archive_path = materialize_artifact(
        reference,
        destination.with_suffix(".tar.zst"),
        maximum_size=MAX_TRANSCRIPT_BUNDLE_BYTES,
        expected_s3_key=(
            transcript_bundle_s3_key(run_id)
            if urlparse(reference.uri).scheme == "s3"
            else None
        ),
    )
    root = extract_archive(
        archive_path,
        destination,
        maximum_entries=MAX_TRANSCRIPT_BUNDLE_ENTRIES,
        maximum_extracted_bytes=MAX_EXTRACTED_TRANSCRIPT_BYTES,
    )
    manifest = json.loads(
        (root / TRANSCRIPT_BUNDLE_MANIFEST).read_text(encoding="utf-8")
    )
    if manifest.get("version") != 1 or manifest.get("run_id") != run_id:
        raise ValueError(
            "Transcript bundle manifest does not match the extraction request."
        )
    units = manifest.get("review_units")
    if not isinstance(units, list):
        raise ValueError("Transcript bundle manifest has no review units.")
    for unit in units:
        if not isinstance(unit, dict) or unit.get("id") != review_unit_id:
            continue
        paths = unit.get("transcripts")
        if not isinstance(paths, list) or not paths:
            raise ValueError("Transcript review unit has no transcript files.")
        resolved_paths: list[Path] = []
        for value in paths:
            if not isinstance(value, str):
                raise ValueError("Transcript manifest path must be a string.")
            path = (root / value).resolve()
            try:
                path.relative_to(root.resolve())
            except ValueError as error:
                raise ValueError("Transcript manifest path escapes bundle.") from error
            if not path.is_file() or path.suffix != TRANSCRIPT_SUFFIX:
                raise ValueError(f"Transcript bundle file is missing: {value}")
            resolved_paths.append(path)
        return MaterializedTranscriptUnit(
            review_unit_id=review_unit_id,
            transcript_paths=tuple(resolved_paths),
        )
    raise ValueError(f"Transcript review unit not found: {review_unit_id}")


__all__ = [
    "MaterializedTranscriptUnit",
    "TranscriptReviewUnit",
    "materialize_transcript_unit",
    "publish_transcript_bundle",
    "transcript_bundle_s3_key",
]
