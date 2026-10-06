"""Validate caller input and resolve the local paths used by review workflows."""

import hashlib
import json
import shutil
import tarfile
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from sec_review_agents.artifacts.input_storage import (
    ARTIFACT_S3_BUCKET_ENV,
    download_s3_input_bundle,
)
from sec_review_agents.entrypoints.contract_schema import validate_v5_workflow_input
from sec_review_agents.entrypoints.run_protocol import validate_run_id
from sec_review_agents.utils.env import env_value

ISSUE_ARTIFACT_PATHS = {
    "analyzer": "analyzer",
    "mitigator": "mitigator",
    "verifier": "verifier",
}

PULL_REQUEST_ARTIFACT_PATHS = {
    "analyzer": "analyzer",
    "mitigator": "mitigator",
    "verifier": "verifier",
}

REPOSITORY_ARTIFACT_PATHS = {
    "discovery": "discovery",
    "triage": "triage",
    "cases": "cases",
}

INPUT_BUNDLE_MANIFEST_NAME = "manifest.json"
ARTIFACT_ROOT_ENV = "SEC_REVIEW_AGENT_ARTIFACT_ROOT"
RUN_INPUT_ROOT_ENV = "SEC_REVIEW_AGENT_RUN_INPUT_ROOT"
INPUT_BUNDLE_ROOT_ENV = "SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT"
INPUT_BUNDLE_MEDIA_TYPE = "application/vnd.sec-review.input-bundle.v1+tar+zstd"
MAX_INPUT_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024
MAX_INPUT_BUNDLE_ENTRIES = 100_000
MAX_EXTRACTED_INPUT_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024


def prepare_run_input(
    caller_input: dict[str, Any],
    *,
    run_id: str,
    workflow: str,
) -> dict[str, Any]:
    validated_run_id = validate_run_id(run_id)
    return prepare_workflow_input(
        caller_input,
        workflow,
        artifact_root_path=workflow_artifact_root(
            caller_input,
            run_id=validated_run_id,
        ),
        input_root_path=_resolve_run_input_root(run_id=validated_run_id),
        expected_run_id=validated_run_id,
    )


def prepare_workflow_input(
    input_data: dict[str, Any],
    workflow: str,
    *,
    artifact_root_path: str | Path,
    input_root_path: str | Path | None = None,
    expected_run_id: str | None = None,
) -> dict[str, Any]:
    """Turn public workflow input into the filesystem-ready runtime form.

    The caller supplies the review target and an input bundle URI. This function
    keeps that public object unchanged and returns a copy enriched with runner-owned
    paths: ``input_bundle_root_path``, ``artifact_root_path``, ``artifact_paths``,
    and ``bundle_paths``. All bundle paths are read from the manifest and constrained
    to remain inside the input bundle.
    """

    # Validate before adding runner-owned fields, which are not part of the public
    # workflow input contract.
    validate_v5_workflow_input(input_data, workflow)
    prepared = deepcopy(input_data)

    # Resolve the caller's bundle URI at the trusted filesystem boundary.
    prepared["input_bundle_root_path"] = str(
        _materialize_input_bundle(
            prepared.get("input_bundle"),
            destination=(
                Path(input_root_path)
                if input_root_path is not None
                else Path(artifact_root_path) / "input-bundle"
            ),
            expected_run_id=expected_run_id,
        )
    )

    # Artifact paths come from runner configuration, never from caller input.
    _set_workflow_artifact_paths(
        prepared,
        workflow,
        artifact_root_path=artifact_root_path,
    )
    if workflow == "repository-review":
        _validate_repository_incremental_range(prepared)

    # Translate bundle-relative manifest entries into paths consumed by workflows.
    _set_bundle_paths_from_manifest(prepared, workflow)
    return prepared


def workflow_artifact_root(input_data: dict[str, Any], *, run_id: str) -> Path:
    return _resolve_artifact_root(
        run_id=run_id,
    )


def _materialize_input_bundle(
    value: object,
    *,
    destination: Path,
    expected_run_id: str | None = None,
) -> Path:
    if not isinstance(value, dict):
        raise ValueError("Runner input is missing input_bundle.")
    uri = value.get("uri")
    digest = value.get("digest")
    size_bytes = value.get("size_bytes")
    media_type = value.get("media_type")
    if not isinstance(uri, str) or not uri.strip():
        raise ValueError("Runner input input_bundle.uri must be non-empty.")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool):
        raise ValueError("Runner input input_bundle.size_bytes must be an integer.")
    if media_type != INPUT_BUNDLE_MEDIA_TYPE:
        raise ValueError("Runner input input_bundle.media_type is unsupported.")

    parsed = urlparse(uri.strip())
    if parsed.scheme == "file":
        if (
            expected_run_id is not None
            and env_value(ARTIFACT_S3_BUCKET_ENV) is not None
        ):
            raise ValueError(
                "Runner input input_bundle.uri must use s3 in object-storage mode."
            )
        if parsed.netloc not in {"", "localhost"}:
            raise ValueError("Runner input input_bundle file URI must be local.")
        archive_path = Path(unquote(parsed.path))
        configured_root = env_value(INPUT_BUNDLE_ROOT_ENV)
        resolved_archive = archive_path.expanduser().resolve()
        if configured_root is not None:
            allowed_root = Path(configured_root).expanduser().resolve()
            try:
                resolved_archive.relative_to(allowed_root)
            except ValueError as error:
                raise ValueError(
                    "Runner input input_bundle.uri must resolve under "
                    f"{INPUT_BUNDLE_ROOT_ENV}."
                ) from error
    elif parsed.scheme == "s3":
        resolved_archive = download_s3_input_bundle(
            uri.strip(),
            destination.with_suffix(".tar.zst"),
            expected_size=size_bytes,
            maximum_size=MAX_INPUT_BUNDLE_BYTES,
            expected_key=(
                f"runs/{expected_run_id}/input/input-bundle.v1.tar.zst"
                if expected_run_id is not None
                else None
            ),
        ).resolve()
    else:
        raise ValueError(f"Unsupported input_bundle URI scheme: {parsed.scheme}")
    if not resolved_archive.is_file():
        raise ValueError(f"Input bundle archive not found: {resolved_archive}")
    archive_size = resolved_archive.stat().st_size
    if archive_size > MAX_INPUT_BUNDLE_BYTES:
        raise ValueError("Input bundle archive exceeds the compressed size limit.")
    if archive_size != size_bytes:
        raise ValueError(
            "Input bundle archive size does not match input_bundle.size_bytes."
        )
    digest_hash = hashlib.sha256()
    with resolved_archive.open("rb") as archive_file:
        while chunk := archive_file.read(1024 * 1024):
            digest_hash.update(chunk)
    actual_digest = digest_hash.hexdigest()
    if digest != f"sha256:{actual_digest}":
        raise ValueError(
            "Input bundle archive digest does not match input_bundle.digest."
        )

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    # The archive is fully local before extraction; agents never perform random
    # reads against object storage. Python 3.14 handles zstd natively here.
    with tarfile.open(resolved_archive, mode="r:zst") as archive:
        _validate_archive_members(archive, destination)
        archive.extractall(destination, filter="data")
    return destination


def _validate_archive_members(archive: tarfile.TarFile, destination: Path) -> None:
    resolved_destination = destination.resolve()
    members = archive.getmembers()
    if len(members) > MAX_INPUT_BUNDLE_ENTRIES:
        raise ValueError("Input bundle archive exceeds the entry count limit.")
    extracted_size = 0
    for member in members:
        if member.isdev() or member.issym() or member.islnk():
            raise ValueError(
                f"Input bundle archive contains unsafe entry: {member.name}"
            )
        if member.isfile():
            extracted_size += member.size
            if extracted_size > MAX_EXTRACTED_INPUT_BUNDLE_BYTES:
                raise ValueError(
                    "Input bundle archive exceeds the extracted size limit."
                )
        candidate = (destination / member.name).resolve()
        try:
            candidate.relative_to(resolved_destination)
        except ValueError as error:
            raise ValueError(
                f"Input bundle archive path escapes its destination: {member.name}"
            ) from error


def _set_workflow_artifact_paths(
    input_data: dict[str, Any],
    workflow: str,
    *,
    artifact_root_path: str | Path,
) -> None:
    artifact_root = Path(artifact_root_path)

    if workflow == "issue-review":
        artifact_paths = ISSUE_ARTIFACT_PATHS
    elif workflow == "pull-request-review":
        artifact_paths = PULL_REQUEST_ARTIFACT_PATHS
    elif workflow == "repository-review":
        artifact_paths = REPOSITORY_ARTIFACT_PATHS
    else:
        raise AssertionError(f"Unsupported prepared workflow: {workflow}")

    # Prepared workflow input may include runner-owned artifact paths
    # after caller validation. Keep those fields out of caller input.
    input_data["artifact_root_path"] = str(artifact_root)
    input_data["artifact_paths"] = {
        key: str(artifact_root / directory_name)
        for key, directory_name in artifact_paths.items()
    }


def _resolve_artifact_root(*, run_id: str) -> Path:
    configured_root = env_value(ARTIFACT_ROOT_ENV)
    if configured_root is not None:
        artifact_root = Path(configured_root).expanduser().resolve()
        run_artifact_root = (artifact_root / run_id).resolve()
        # Keep this check even though public run_id is slug-shaped; this is the
        # filesystem boundary for any future caller of workflow_artifact_root.
        try:
            run_artifact_root.relative_to(artifact_root)
        except ValueError as error:
            raise ValueError(
                f"Runner run_id resolves outside {ARTIFACT_ROOT_ENV}."
            ) from error
        return run_artifact_root
    return Path(".agent-artifacts").resolve() / run_id


def _resolve_run_input_root(*, run_id: str) -> Path:
    """Keep materialized caller input outside the publishable artifact tree."""
    configured_root = env_value(RUN_INPUT_ROOT_ENV)
    input_root = (
        Path(configured_root).expanduser().resolve()
        if configured_root is not None
        else Path(".agent-run-inputs").resolve()
    )
    run_input_root = (input_root / run_id).resolve()
    try:
        run_input_root.relative_to(input_root)
    except ValueError as error:
        raise ValueError(
            f"Runner run_id resolves outside {RUN_INPUT_ROOT_ENV}."
        ) from error
    return run_input_root


def _set_bundle_paths_from_manifest(
    input_data: dict[str, Any],
    workflow: str,
) -> None:
    local_root = Path(input_data["input_bundle_root_path"])
    manifest_path = local_root / INPUT_BUNDLE_MANIFEST_NAME
    if not manifest_path.is_file():
        raise ValueError(f"Input bundle manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Input bundle manifest must be an object.")
    if manifest.get("contract_version") != "v5":
        raise ValueError("Input bundle manifest contract_version must be 'v5'.")
    if manifest.get("kind") != "runner-input-bundle":
        raise ValueError("Input bundle manifest kind must be 'runner-input-bundle'.")

    bundle_paths: dict[str, str] = {
        "workspace_snapshot_tar_path": str(
            _resolve_bundle_path(
                local_root,
                _read_required_manifest_path(
                    manifest.get("workspace"), "workspace.snapshot"
                ),
            )
        ),
        "history_path": str(
            _resolve_bundle_path(
                local_root,
                _read_required_manifest_path(manifest.get("history"), "history.path"),
            )
        ),
    }

    incremental_window = manifest.get("incremental_window")
    if isinstance(incremental_window, dict):
        bundle_paths["incremental_window_path"] = str(
            _resolve_bundle_path(
                local_root,
                _read_required_manifest_path(
                    incremental_window, "incremental_window.path"
                ),
            )
        )
    elif workflow == "pull-request-review":
        raise ValueError(
            "Pull request input bundle manifest requires incremental_window.path."
        )
    elif (
        workflow == "repository-review"
        and (input_data.get("scan_target") or {}).get("scan_mode") == "incremental"
    ):
        raise ValueError(
            "Incremental repository input bundle manifest requires incremental_window.path."
        )

    input_data["bundle_paths"] = bundle_paths


def _read_required_manifest_path(value: object, label: str) -> str:
    if not isinstance(value, dict):
        raise ValueError(f"Input bundle manifest requires {label}.")
    leaf = label.rsplit(".", 1)[-1]
    path_value = value.get(leaf)
    if isinstance(path_value, str) and path_value.strip():
        return path_value.strip()
    raise ValueError(f"Input bundle manifest requires {label}.")


def _resolve_bundle_path(local_root: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"Input bundle manifest path must be bundle-relative: {value}")
    candidate = local_root / path
    resolved_root = local_root.resolve()
    resolved_candidate = candidate.resolve(strict=False)
    try:
        resolved_candidate.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(
            "Input bundle manifest path must resolve within the input bundle: "
            f"{value}"
        ) from error
    return candidate


def _validate_repository_incremental_range(input_data: dict[str, Any]) -> None:
    scan_target = input_data.get("scan_target") or {}
    if scan_target.get("scan_mode") != "incremental":
        return

    base_sha = scan_target.get("base_sha")
    head_sha = scan_target.get("head_sha")
    if (
        isinstance(base_sha, str)
        and isinstance(head_sha, str)
        and base_sha.strip() == head_sha.strip()
    ):
        raise ValueError(
            "Repository incremental scan input scan_target.base_sha must differ from head_sha."
        )


__all__ = [
    "prepare_run_input",
    "prepare_workflow_input",
]
