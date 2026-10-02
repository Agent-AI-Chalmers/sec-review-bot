import json
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from sec_review_agents.entrypoints.contract_schema import validate_v4_workflow_input
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
INPUT_BUNDLE_ROOT_ENV = "SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT"


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
    )


def prepare_workflow_input(
    input_data: dict[str, Any],
    workflow: str,
    *,
    artifact_root_path: str | Path,
) -> dict[str, Any]:
    """Validate caller input and prepare the workflow runtime input."""

    validate_v4_workflow_input(input_data, workflow)
    prepared = deepcopy(input_data)
    _derive_input_bundle_root_path(prepared)
    _derive_workflow_artifact_paths(
        prepared,
        workflow,
        artifact_root_path=artifact_root_path,
    )
    if workflow == "repository-review":
        _require_repository_scan_relationships(prepared)
    _derive_bundle_paths(prepared, workflow)
    return prepared


def workflow_artifact_root(input_data: dict[str, Any], *, run_id: str) -> Path:
    return _artifact_root(
        input_bundle_root=_input_bundle_root(input_data.get("input_bundle_uri")),
        run_id=run_id,
    )


def _derive_input_bundle_root_path(input_data: dict[str, Any]) -> None:
    input_data["input_bundle_root_path"] = str(
        _input_bundle_root(input_data.get("input_bundle_uri"))
    )


def _input_bundle_root(value: object) -> Path:
    uri = _string_value(value)
    if uri is None:
        raise ValueError("Runner input is missing input_bundle_uri.")

    parsed = urlparse(uri)
    if parsed.scheme == "file":
        if parsed.netloc not in {"", "localhost"}:
            raise ValueError("Runner input input_bundle_uri file URI must be local.")
        path = Path(unquote(parsed.path))
    elif parsed.scheme:
        raise ValueError(f"Unsupported input_bundle_uri scheme: {parsed.scheme}")
    else:
        path = Path(uri)

    configured_root = env_value(INPUT_BUNDLE_ROOT_ENV)
    if configured_root is None:
        return path

    bundle_root = path.expanduser().resolve()
    allowed_root = Path(configured_root).expanduser().resolve()
    try:
        bundle_root.relative_to(allowed_root)
    except ValueError as error:
        raise ValueError(
            "Runner input input_bundle_uri must resolve under "
            f"{INPUT_BUNDLE_ROOT_ENV}."
        ) from error
    return bundle_root


def _derive_workflow_artifact_paths(
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

    # Prepared workflow input is allowed to grow runner-derived artifact roots
    # after caller validation. Keep those fields out of caller input.
    input_data["artifact_root_path"] = str(artifact_root)
    input_data["artifact_paths"] = {
        key: str(artifact_root / directory_name)
        for key, directory_name in artifact_paths.items()
    }


def _artifact_root(*, input_bundle_root: Path, run_id: str) -> Path:
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
    return input_bundle_root / "artifacts"


def _derive_bundle_paths(input_data: dict[str, Any], workflow: str) -> None:
    local_root = Path(input_data["input_bundle_root_path"])
    manifest_path = local_root / INPUT_BUNDLE_MANIFEST_NAME
    if not manifest_path.is_file():
        raise ValueError(f"Input bundle manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Input bundle manifest must be an object.")
    if manifest.get("contract_version") != "v4":
        raise ValueError("Input bundle manifest contract_version must be 'v4'.")
    if manifest.get("kind") != "runner-input-bundle":
        raise ValueError("Input bundle manifest kind must be 'runner-input-bundle'.")

    bundle_paths: dict[str, str] = {
        "workspace_snapshot_tar_path": str(
            _bundle_relative_path(
                local_root,
                _required_manifest_path(
                    manifest.get("workspace"), "workspace.snapshot"
                ),
            )
        ),
        "history_path": str(
            _bundle_relative_path(
                local_root,
                _required_manifest_path(manifest.get("history"), "history.path"),
            )
        ),
    }

    incremental_window = manifest.get("incremental_window")
    if isinstance(incremental_window, dict):
        bundle_paths["incremental_window_path"] = str(
            _bundle_relative_path(
                local_root,
                _required_manifest_path(incremental_window, "incremental_window.path"),
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


def _required_manifest_path(value: object, label: str) -> str:
    if not isinstance(value, dict):
        raise ValueError(f"Input bundle manifest requires {label}.")
    leaf = label.rsplit(".", 1)[-1]
    path_value = value.get(leaf)
    if isinstance(path_value, str) and path_value.strip():
        return path_value.strip()
    raise ValueError(f"Input bundle manifest requires {label}.")


def _bundle_relative_path(local_root: Path, value: str) -> Path:
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


def _require_repository_scan_relationships(input_data: dict[str, Any]) -> None:
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


def _string_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


__all__ = [
    "prepare_run_input",
    "prepare_workflow_input",
]
