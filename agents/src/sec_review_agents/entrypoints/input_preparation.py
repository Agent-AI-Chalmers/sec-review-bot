"""Validate caller input and resolve the local paths used by review workflows."""

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from sec_review_agents.artifacts.archive import extract_archive
from sec_review_agents.artifacts.s3_adapter import (
    ARTIFACT_S3_BUCKET_ENV,
    download_s3_object,
)
from sec_review_agents.artifacts.uri import parse_artifact_uri, parse_local_artifact_uri
from sec_review_agents.entrypoints.execution_api_schema import (
    validate_execution_api_input,
    validate_execution_api_input_bundle_manifest,
)
from sec_review_agents.entrypoints.execution_protocol import validate_run_id
from sec_review_agents.entrypoints.input_bundle_artifact import (
    validate_input_bundle_entries,
)
from sec_review_agents.scan_stages.input import RepositoryScanScope
from sec_review_agents.utils.env import env_value
from sec_review_agents.workflows.prepared_input import (
    PreparedIssueInput,
    PreparedPullRequestInput,
    PreparedRepositoryInput,
    PreparedWorkflowInput,
)
from sec_review_agents.workflows.review_intent import require_review_intent

INPUT_BUNDLE_MANIFEST_NAME = "manifest.json"
ARTIFACT_ROOT_ENV = "SEC_REVIEW_AGENT_ARTIFACT_ROOT"
RUN_INPUT_ROOT_ENV = "SEC_REVIEW_AGENT_RUN_INPUT_ROOT"
INPUT_BUNDLE_ROOT_ENV = "SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT"
INPUT_BUNDLE_MEDIA_TYPE = "application/tar+zstd"
MAX_INPUT_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024
MAX_INPUT_BUNDLE_ENTRIES = 100_000
MAX_EXTRACTED_INPUT_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024


def prepare_run_input(
    caller_input: dict[str, Any],
    *,
    run_id: str,
    workflow: str,
) -> PreparedWorkflowInput:
    validated_run_id = validate_run_id(run_id)
    return prepare_workflow_input(
        caller_input,
        workflow,
        artifact_root_path=workflow_artifact_root(
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
) -> PreparedWorkflowInput:
    """Validate public JSON, materialize its bundle, then construct runtime input."""
    validate_execution_api_input(input_data, workflow)
    bundle_root = _materialize_input_bundle(
        input_data.get("input_bundle"),
        destination=(
            Path(input_root_path)
            if input_root_path is not None
            else Path(artifact_root_path) / "input-bundle"
        ),
        expected_run_id=expected_run_id,
    )
    artifact_root = Path(artifact_root_path)
    scan_target = input_data.get("scan_target") or {}
    if workflow == "repository-review":
        _validate_repository_incremental_range(input_data)
    bundle_paths = _read_bundle_paths(
        bundle_root, workflow, scan_target.get("scan_mode")
    )
    common: dict[str, Any] = {
        "input_bundle_root_path": str(bundle_root),
        "artifact_root_path": str(artifact_root),
        "workspace_snapshot_tar_path": bundle_paths["workspace_snapshot_tar_path"],
        "history_path": bundle_paths["history_path"],
        "review_intent": require_review_intent(input_data.get("review_intent")),
        "setup_declaration": input_data.get("setup_declaration"),
    }
    if workflow == "issue-review":
        return PreparedIssueInput(
            **common,
            issue=deepcopy(input_data["issue"]),
            analyzer_artifacts_path=str(artifact_root / "analyzer"),
            mitigator_artifacts_path=str(artifact_root / "mitigator"),
            verifier_artifacts_path=str(artifact_root / "verifier"),
        )
    if workflow == "pull-request-review":
        return PreparedPullRequestInput(
            **common,
            pr=deepcopy(input_data["pr"]),
            incremental_window_path=bundle_paths["incremental_window_path"],
            analyzer_artifacts_path=str(artifact_root / "analyzer"),
            mitigator_artifacts_path=str(artifact_root / "mitigator"),
            verifier_artifacts_path=str(artifact_root / "verifier"),
        )
    if workflow == "repository-review":
        return PreparedRepositoryInput(
            **common,
            scan_mode=scan_target["scan_mode"],
            base_sha=scan_target.get("base_sha"),
            head_sha=scan_target.get("head_sha"),
            scan_scope=RepositoryScanScope.model_validate(input_data["scan_scope"]),
            incremental_window_path=bundle_paths.get("incremental_window_path"),
            discovery_artifacts_path=str(artifact_root / "discovery"),
            triage_artifacts_path=str(artifact_root / "triage"),
            cases_artifacts_path=str(artifact_root / "cases"),
        )
    raise AssertionError(f"Unsupported prepared workflow: {workflow}")


def _materialize_input_bundle(
    value: object,
    *,
    destination: Path,
    expected_run_id: str | None = None,
) -> Path:
    if not isinstance(value, dict):
        raise ValueError("Execution input is missing input_bundle.")
    uri = value.get("uri")
    digest = value.get("digest")
    size_bytes = value.get("size_bytes")
    media_type = value.get("media_type")
    if not isinstance(uri, str) or not uri.strip():
        raise ValueError("Execution input input_bundle.uri must be non-empty.")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool):
        raise ValueError("Execution input input_bundle.size_bytes must be an integer.")
    if media_type != INPUT_BUNDLE_MEDIA_TYPE:
        raise ValueError("Execution input input_bundle.media_type is unsupported.")

    if not isinstance(digest, str):
        raise ValueError("Execution input input_bundle.digest must be a string.")
    parsed = parse_artifact_uri(uri)
    if parsed.scheme == "file":
        if (
            expected_run_id is not None
            and env_value(ARTIFACT_S3_BUCKET_ENV) is not None
        ):
            raise ValueError("Execution input input_bundle.uri must use s3 in S3 mode.")
        archive_path = parse_local_artifact_uri(uri)
        configured_root = env_value(INPUT_BUNDLE_ROOT_ENV)
        resolved_archive = archive_path.expanduser().resolve()
        if configured_root is not None:
            allowed_root = Path(configured_root).expanduser().resolve()
            try:
                resolved_archive.relative_to(allowed_root)
            except ValueError as error:
                raise ValueError(
                    "Execution input input_bundle.uri must resolve under "
                    f"{INPUT_BUNDLE_ROOT_ENV}."
                ) from error
    elif parsed.scheme == "s3":
        expected_key = (
            f"runs/{expected_run_id}/input/{digest.removeprefix('sha256:')}"
            "/input-bundle.v1.tar.zst"
            if expected_run_id is not None
            else None
        )
        resolved_archive = download_s3_object(
            uri,
            destination.with_suffix(".tar.zst"),
            expected_size=size_bytes,
            maximum_size=MAX_INPUT_BUNDLE_BYTES,
            expected_key=expected_key,
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

    return extract_archive(
        resolved_archive,
        destination,
        maximum_entries=MAX_INPUT_BUNDLE_ENTRIES,
        maximum_extracted_bytes=MAX_EXTRACTED_INPUT_BUNDLE_BYTES,
        validate_profile=validate_input_bundle_entries,
    )


def workflow_artifact_root(*, run_id: str) -> Path:
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
                f"Execution run_id resolves outside {ARTIFACT_ROOT_ENV}."
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
            f"Execution run_id resolves outside {RUN_INPUT_ROOT_ENV}."
        ) from error
    return run_input_root


def _read_bundle_paths(
    local_root: Path,
    workflow: str,
    scan_mode: str | None,
) -> dict[str, str]:
    manifest_path = local_root / INPUT_BUNDLE_MANIFEST_NAME
    if not manifest_path.is_file():
        raise ValueError(f"Input bundle manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_execution_api_input_bundle_manifest(manifest)

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
    elif workflow == "repository-review" and scan_mode == "incremental":
        raise ValueError(
            "Incremental repository input bundle manifest requires incremental_window.path."
        )

    return bundle_paths


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
