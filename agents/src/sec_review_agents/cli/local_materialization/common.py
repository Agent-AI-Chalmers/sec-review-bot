import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from sec_review_agents.artifacts.reference import local_artifact_reference
from sec_review_agents.artifacts.tar_zstd import canonical_tar_info
from sec_review_agents.contract_versions import EXECUTION_API_VERSION
from sec_review_agents.entrypoints.setup_declaration import (
    SetupDeclarationError,
    is_blank_setup_declaration,
    parse_setup_declaration,
)
from sec_review_agents.filesystem.backend_selection import (
    selected_sandbox_backend_kind,
)
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


def read_setup_declaration_file(path: str | Path | None) -> str | None:
    """Read and validate a local setup declaration file into its inline text form.

    Returns None when no path is given, or when the file holds only whitespace
    (blank content means "no declaration"). Raises ValueError when the path does
    not point at a readable file, so a typo fails fast instead of silently
    skipping bootstrap, and when the content is not a valid declaration -- the
    same content rules the GitHub integration enforces, so a local run fails the
    same way a repository's default-branch declaration would.
    """
    if path is None:
        return None
    resolved = Path(path).expanduser()
    try:
        content = resolved.read_text(encoding="utf-8")
    except OSError as error:
        raise ValueError(
            f"Unable to read setup declaration file: {resolved} ({error})"
        ) from error
    if is_blank_setup_declaration(content):
        return None
    try:
        parse_setup_declaration(content)
    except SetupDeclarationError as error:
        raise ValueError(
            f"Invalid setup declaration file: {resolved} ({error})"
        ) from error
    return content


def load_setup_declaration_content(path: str | Path | None) -> str | None:
    """Resolve the setup declaration text for the selected sandbox backend.

    Only the docker backend runs a setup declaration (its container is
    long-lived). On any other backend the declaration cannot take effect, so
    warn once and return None without reading the file -- a missing or
    unreadable file must not fail a run whose declaration would be ignored
    anyway. On docker, a path that cannot be read is a real error and raises.
    """
    if path is None:
        return None
    backend = selected_sandbox_backend_kind()
    if backend != "docker":
        print(
            f"SETUP_DECLARATION_WARNING=--setup-declaration was provided but the "
            f"selected sandbox backend ({backend!r}) does not run setup "
            f"declarations; the declaration is ignored.",
            file=sys.stderr,
        )
        return None
    return read_setup_declaration_file(path)


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
        "api_version": EXECUTION_API_VERSION,
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


def archive_input_bundle(
    paths: MaterializedRunPaths,
    *,
    include_incremental_window: bool,
) -> dict[str, object]:
    """Create the immutable public input artifact from prepared local material."""
    archive_path = Path(f"{paths.local_root_path}.tar.zst")
    entries = [
        BUNDLE_MANIFEST_NAME,
        "history",
        *(["incremental-window"] if include_incremental_window else []),
        "workspace.snapshot.tar",
    ]
    archive_path.unlink(missing_ok=True)

    # The live checkout is staging state, not bundle content. The uncompressed
    # workspace snapshot remains inside because the Execution Worker reuses it when creating
    # isolated stage workspaces; only the outer transport archive is compressed.
    with tarfile.open(archive_path, mode="w:zst", format=tarfile.PAX_FORMAT) as archive:
        for entry in entries:
            archive.add(
                paths.local_root_path / entry,
                arcname=entry,
                filter=canonical_tar_info,
            )
    reference = local_artifact_reference(archive_path).as_dict()
    # Local execution consumes the snapshot, not the preparation checkout.
    # Remove the redundant repository copy only after the archive is complete.
    shutil.rmtree(workspace_path(paths), ignore_errors=True)
    return reference


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
