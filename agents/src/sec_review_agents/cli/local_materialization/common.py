import secrets
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from sec_review_agents.utils.env import env_value

IssueReviewStrategy = Literal["default", "two-stage", "single-agent"]
ReviewWorkflow = Literal[
    "issue-review",
    "pull-request-review",
    "repository-review",
]
BUNDLE_MANIFEST_NAME = "manifest.json"
LOCAL_INPUT_BUNDLE_ROOT_ENV = "SEC_REVIEW_INPUT_BUNDLE_ROOT"


def create_local_run_id() -> str:
    return f"local-run-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(4)}"


@dataclass(frozen=True)
class MaterializedRunPaths:
    local_root_path: Path
    artifact_root_path: Path


@dataclass(frozen=True)
class ReviewBundle:
    workflow: ReviewWorkflow
    run_id: str
    input: dict[str, Any]
    # Root directory for the local input bundle and replayable run materials.
    local_root_path: Path
    # Root directory where this local run writes workflow/stage artifacts.
    artifact_root_path: Path
    # Local-only runtime options such as workspace image.
    runtime_config: dict[str, Any] | None = None
    issue_strategy: IssueReviewStrategy | None = None


def build_run_paths(base_dir: Path, run_id: str) -> MaterializedRunPaths:
    local_root_path = base_dir / run_id
    artifact_root_path = local_root_path / "artifacts"
    return MaterializedRunPaths(
        local_root_path=local_root_path,
        artifact_root_path=artifact_root_path,
    )


def workspace_path(paths: MaterializedRunPaths) -> Path:
    return paths.local_root_path / "workspace"


def history_path(paths: MaterializedRunPaths) -> Path:
    return paths.local_root_path / "history"


def incremental_window_path(paths: MaterializedRunPaths) -> Path:
    return paths.local_root_path / "incremental-window"


def ensure_run_directories(
    paths: MaterializedRunPaths,
    *,
    include_repository_artifacts: bool = False,
) -> None:
    directory_paths = [
        history_path(paths),
    ]
    if include_repository_artifacts:
        directory_paths.extend(
            [
                paths.artifact_root_path / "discovery",
                paths.artifact_root_path / "triage",
                paths.artifact_root_path / "cases",
            ]
        )
    for path in directory_paths:
        path.mkdir(parents=True, exist_ok=True)


def write_input_bundle_manifest(
    paths: MaterializedRunPaths,
    *,
    include_incremental_window: bool,
) -> None:
    manifest: dict[str, Any] = {
        "contract_version": "v4",
        "kind": "runner-input-bundle",
        "workspace": {
            "snapshot": "workspace.snapshot.tar",
        },
        "history": {
            "path": "history",
        },
    }
    if include_incremental_window:
        manifest["incremental_window"] = {
            "path": "incremental-window",
        }
    from sec_review_agents.utils.files import write_json

    write_json(paths.local_root_path / BUNDLE_MANIFEST_NAME, manifest)


def initialize_workspace_git_repo(workspace_path: Path) -> None:
    """Create a local baseline commit for later workspace.patch generation."""
    # Disable auto-gc while writing objects so a concurrent workspace copy does not
    # race with loose-object pruning; then pack the repo once before snapshotting.
    subprocess.run(
        ["git", "init"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "sec-review-agents"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "sec-review-agents@localhost"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "-c", "gc.auto=0", "add", "--all", "."],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            "git",
            "-c",
            "gc.auto=0",
            "commit",
            "--allow-empty",
            "-m",
            "chore: initialize workspace snapshot",
        ],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "-c", "gc.auto=0", "gc", "--quiet"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )


def materialize_workspace_with_limited_commit_history(
    *,
    source_repo_path: Path,
    workspace_path: Path,
    refs: list[str],
) -> None:
    normalized_refs: list[str] = []
    for ref in refs:
        candidate = str(ref).strip()
        if candidate and candidate not in normalized_refs:
            normalized_refs.append(candidate)
    if not normalized_refs:
        raise ValueError(
            "materialize_workspace_with_limited_commit_history requires at least one ref."
        )

    shutil.rmtree(workspace_path, ignore_errors=True)
    workspace_path.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ["git", "init"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "sec-review-agents"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "sec-review-agents@localhost"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "remote", "add", "origin", str(source_repo_path.resolve())],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        [
            "git",
            "-c",
            "gc.auto=0",
            "fetch",
            "--no-tags",
            # Single-ref materialization keeps a real HEAD workspace while
            # bounding issue/full runs to a shallow history window. Multi-ref
            # materialization keeps the commit relationships needed by PR and
            # incremental review flows.
            *(["--depth=1"] if len(normalized_refs) == 1 else []),
            "origin",
            *normalized_refs,
        ],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    head_ref = normalized_refs[-1]
    subprocess.run(
        ["git", "-c", "gc.auto=0", "checkout", "--detach", head_ref],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    # Preserve fetched task-window objects but remove the remote so agents cannot
    # trivially fetch or switch to newer refs outside the intended local review scope.
    subprocess.run(
        ["git", "remote", "remove", "origin"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "-c", "gc.auto=0", "gc", "--quiet"],
        cwd=workspace_path,
        check=True,
        capture_output=True,
        text=True,
    )


def default_local_output_dir() -> Path:
    configured_root = env_value(LOCAL_INPUT_BUNDLE_ROOT_ENV)
    if configured_root:
        return Path(configured_root)
    return Path(tempfile.gettempdir()) / "sec-review-agents-local-runs"


def effective_issue_strategy(bundle: ReviewBundle) -> IssueReviewStrategy:
    return bundle.issue_strategy or "default"


def result_path_for_bundle(bundle: ReviewBundle) -> Path:
    issue_strategy = effective_issue_strategy(bundle)
    if issue_strategy != "default":
        return (
            bundle.local_root_path / f"{bundle.workflow}.{issue_strategy}-result.json"
        )
    return bundle.local_root_path / f"{bundle.workflow}-result.json"
