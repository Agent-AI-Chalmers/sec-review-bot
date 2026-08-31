import json
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from sec_review_agents.utils.env import env_value

COMMON_REQUIRED_FIELDS = (
    "contract_version",
    "input_bundle_uri",
    "review_intent",
)

COMMON_INPUT_ALLOWED_FIELDS = frozenset(COMMON_REQUIRED_FIELDS)

INPUT_ALLOWED_FIELDS_BY_WORKFLOW: dict[str, frozenset[str]] = {
    "issue-review": COMMON_INPUT_ALLOWED_FIELDS
    | frozenset(
        {
            "issue",
        }
    ),
    "pull-request-review": COMMON_INPUT_ALLOWED_FIELDS
    | frozenset(
        {
            "pr",
        }
    ),
    "repository-review": COMMON_INPUT_ALLOWED_FIELDS
    | frozenset(
        {
            "scan_target",
            "scan_scope",
        }
    ),
}

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


def prepare_workflow_input(
    input_data: dict[str, Any],
    workflow: str,
    *,
    artifact_root_path: str | Path,
) -> dict[str, Any]:
    """Validate caller input and prepare the workflow runtime input."""

    if workflow not in INPUT_ALLOWED_FIELDS_BY_WORKFLOW:
        raise ValueError(
            f"Unsupported workflow for workflow input preparation: {workflow}"
        )

    prepared = deepcopy(input_data)
    _require_allowed_input_fields(prepared, workflow)
    _require_common_input_shape(prepared)
    _require_review_intent_semantics(prepared, workflow)
    _derive_input_bundle_root_path(prepared)
    _derive_workflow_artifact_paths(
        prepared,
        workflow,
        artifact_root_path=artifact_root_path,
    )
    _require_workflow_input_shape(prepared, workflow)
    _derive_bundle_paths(prepared, workflow)
    return prepared


def workflow_artifact_root(input_data: dict[str, Any], *, run_id: str) -> Path:
    return _artifact_root(
        input_bundle_root=_input_bundle_root(input_data.get("input_bundle_uri")),
        run_id=run_id,
    )


def _require_common_input_shape(input_data: dict[str, Any]) -> None:
    missing = [
        field
        for field in COMMON_REQUIRED_FIELDS
        if field not in input_data or input_data.get(field) in (None, "")
    ]
    if missing:
        raise ValueError(
            f"Runner input is missing required field(s): {', '.join(missing)}"
        )

    if input_data.get("contract_version") != "v4":
        raise ValueError(
            f"Unsupported input contract_version: {input_data.get('contract_version')}"
        )

    if not isinstance(input_data.get("review_intent"), dict):
        raise ValueError("Runner input field must be an object: review_intent")


def _require_review_intent_semantics(input_data: dict[str, Any], workflow: str) -> None:
    from sec_review_agents.workflows.review_intent import (
        REVIEW_OBJECTIVE_AUDIT,
        require_review_intent,
    )

    review_intent = require_review_intent(input_data.get("review_intent"))
    if workflow in {"pull-request-review", "repository-review"}:
        if review_intent.objective != REVIEW_OBJECTIVE_AUDIT:
            raise ValueError("review_intent.objective must be 'audit'.")
    elif workflow != "issue-review":
        raise AssertionError(f"Unsupported prepared workflow: {workflow}")


def _require_allowed_input_fields(input_data: dict[str, Any], workflow: str) -> None:
    allowed_fields = INPUT_ALLOWED_FIELDS_BY_WORKFLOW[workflow]
    unexpected = sorted(key for key in input_data if key not in allowed_fields)
    if unexpected:
        raise ValueError(
            "Runner input contains unsupported field(s): " + ", ".join(unexpected)
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


def _require_workflow_input_shape(input_data: dict[str, Any], workflow: str) -> None:
    if workflow == "issue-review":
        _require_object_field(input_data, "issue")
        return

    if workflow == "pull-request-review":
        _require_object_field(input_data, "pr")
        return

    if workflow == "repository-review":
        _require_object_field(input_data, "scan_target")
        _require_object_field(input_data, "scan_scope")
        _require_repository_scan_target(input_data["scan_target"])
        _require_repository_scan_scope(input_data["scan_scope"])
        scan_mode = input_data["scan_target"].get("scan_mode")
        if scan_mode == "incremental":
            _require_repository_incremental_scan_fields(input_data)
        else:
            _reject_repository_full_scan_incremental_fields(input_data)
        return


def _require_object_field(input_data: dict[str, Any], key: str) -> None:
    if not isinstance(input_data.get(key), dict):
        raise ValueError(f"Runner input field must be an object: {key}")


def _reject_repository_full_scan_incremental_fields(input_data: dict[str, Any]) -> None:
    scan_target = input_data.get("scan_target") or {}
    if isinstance(scan_target, dict):
        if scan_target.get("base_sha") is not None:
            raise ValueError(
                "Repository full scan input scan_target.base_sha must be null."
            )
        commit_shas = scan_target.get("commit_shas")
        if isinstance(commit_shas, list) and commit_shas:
            raise ValueError(
                "Repository full scan input scan_target.commit_shas must be empty."
            )

    scan_scope = input_data.get("scan_scope") or {}
    incremental_changed_files = (
        scan_scope.get("incremental_changed_files")
        if isinstance(scan_scope, dict)
        else None
    )
    if isinstance(incremental_changed_files, list) and incremental_changed_files:
        raise ValueError(
            "Repository full scan input scan_scope.incremental_changed_files "
            "must be empty."
        )


def _require_repository_incremental_scan_fields(input_data: dict[str, Any]) -> None:
    """Validate incremental-scan cross-field invariants."""
    # Cross-field incremental window invariants live here because the portable JSON Schema stays structural.
    scan_target = input_data.get("scan_target") or {}
    if not isinstance(scan_target, dict):
        return

    base_sha = scan_target.get("base_sha")
    if not _non_empty_string(base_sha):
        raise ValueError(
            "Repository incremental scan input scan_target.base_sha must be a non-empty string."
        )

    head_sha = scan_target.get("head_sha")
    if (
        isinstance(base_sha, str)
        and isinstance(head_sha, str)
        and base_sha.strip() == head_sha.strip()
    ):
        raise ValueError(
            "Repository incremental scan input scan_target.base_sha must differ from head_sha."
        )

    commit_shas = scan_target.get("commit_shas")
    if not isinstance(commit_shas, list) or not commit_shas:
        raise ValueError(
            "Repository incremental scan input scan_target.commit_shas must be non-empty."
        )


def _require_repository_scan_target(scan_target: dict[str, Any]) -> None:
    for key in (
        "target_branch",
        "default_branch",
        "event_type",
        "head_sha",
    ):
        if not _non_empty_string(scan_target.get(key)):
            raise ValueError(
                f"Repository runner input scan_target.{key} must be a non-empty string."
            )

    if scan_target.get("scan_mode") not in {"full", "incremental"}:
        raise ValueError(
            "Repository runner input scan_target.scan_mode must be 'full' or 'incremental'."
        )
    if scan_target.get("event_type") not in {"manual", "scheduled"}:
        raise ValueError(
            "Repository runner input scan_target.event_type must be 'manual' or 'scheduled'."
        )

    if "base_sha" not in scan_target:
        raise ValueError(
            "Repository runner input scan_target.base_sha must be present as null or a non-empty string."
        )
    base_sha = scan_target.get("base_sha")
    if base_sha is not None and not _non_empty_string(base_sha):
        raise ValueError(
            "Repository runner input scan_target.base_sha must be null or a non-empty string."
        )

    commit_shas = scan_target.get("commit_shas")
    if not isinstance(commit_shas, list) or not all(
        _non_empty_string(item) for item in commit_shas
    ):
        raise ValueError(
            "Repository runner input scan_target.commit_shas must be a list of non-empty strings."
        )


def _require_repository_scan_scope(scan_scope: dict[str, Any]) -> None:
    if not isinstance(scan_scope.get("max_file_bytes"), int):
        raise ValueError(
            "Repository runner input scan_scope.max_file_bytes must be an integer."
        )
    paths_ignore = scan_scope.get("paths_ignore")
    if not isinstance(paths_ignore, list):
        raise ValueError(
            "Repository runner input scan_scope.paths_ignore must be a list."
        )
    for index, item in enumerate(paths_ignore):
        if not _non_empty_string(item):
            raise ValueError(
                "Repository runner input scan_scope.paths_ignore"
                f"[{index}] must be a non-empty string."
            )

    # scan_scope is the repository scan cost/coverage boundary. Reject
    # malformed entries here instead of letting discovery silently widen or shrink scope.
    incremental_changed_files = scan_scope.get("incremental_changed_files")
    if not isinstance(incremental_changed_files, list):
        raise ValueError(
            "Repository runner input scan_scope.incremental_changed_files must be a list."
        )
    for index, item in enumerate(incremental_changed_files):
        if not isinstance(item, dict):
            raise ValueError(
                "Repository runner input scan_scope.incremental_changed_files"
                f"[{index}] must be an object."
            )
        if not _non_empty_string(item.get("path")):
            raise ValueError(
                "Repository runner input scan_scope.incremental_changed_files"
                f"[{index}].path must be a non-empty string."
            )
        if not _non_empty_string(item.get("status")):
            raise ValueError(
                "Repository runner input scan_scope.incremental_changed_files"
                f"[{index}].status must be a non-empty string."
            )
        previous_path = item.get("previous_path")
        if previous_path is not None and not isinstance(previous_path, str):
            raise ValueError(
                "Repository runner input scan_scope.incremental_changed_files"
                f"[{index}].previous_path must be a string or null."
            )


def _string_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _non_empty_string(value: Any) -> bool:
    return _string_value(value) is not None


__all__ = [
    "prepare_workflow_input",
]
