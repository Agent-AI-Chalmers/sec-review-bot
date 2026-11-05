import secrets
import shutil
import subprocess
import tarfile
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

IssueReviewStrategy = Literal["default", "two-stage", "single-agent"]
ReviewWorkflow = Literal[
    "issue-review",
    "pull-request-review",
    "repository-review",
]
BUNDLE_MANIFEST_NAME = "manifest.json"


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
    """Read and validate setup instructions for the Docker execution environment."""
    if path is None:
        return None
    selected_sandbox_backend_kind()
    return read_setup_declaration_file(path)


@dataclass(frozen=True)
class ReviewBundle:
    """Local run materials and execution choices, not a worker request.

    Paths relative to ``local_root_path``:

    - ``input/``: extracted execution inputs (manifest, workspace snapshot, history,
      and incremental-window context when applicable).
    - ``input.tar.zst``: transport archive.
    - ``artifacts/``: stage results and trajectories.

    Workflow input and result JSON files live at the run root. Constructing this
    object does not create files.
    """

    workflow: ReviewWorkflow
    run_id: str
    input: dict[str, Any]
    # One local run owns both its input materials and execution artifacts.
    local_root_path: Path
    # Local-only runtime options such as workspace image.
    runtime_config: dict[str, Any] | None = None
    issue_strategy: IssueReviewStrategy | None = None

    @property
    def artifact_root_path(self) -> Path:
        return self.local_root_path / "artifacts"

    @property
    def input_root_path(self) -> Path:
        return self.local_root_path / "input"

    @property
    def archive_path(self) -> Path:
        return self.local_root_path / "input.tar.zst"


def write_input_bundle_manifest(
    input_root: Path,
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

    write_json(input_root / BUNDLE_MANIFEST_NAME, manifest)


def pack_input_bundle(
    bundle: ReviewBundle,
    *,
    input_root: Path,
    include_incremental_window: bool,
) -> dict[str, object]:
    """Pack prepared execution inputs into the transport archive.

    Read the manifest, workspace snapshot, history, and optional incremental
    context from ``input_root``; write ``bundle.archive_path`` and
    return its artifact reference (URI, size, and checksum). Preparation workspace
    cleanup belongs to the caller.
    """
    archive_path = bundle.archive_path
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
                input_root / entry,
                arcname=entry,
                filter=canonical_tar_info,
            )
    reference = local_artifact_reference(archive_path).as_dict()
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


def effective_issue_strategy(bundle: ReviewBundle) -> IssueReviewStrategy:
    return bundle.issue_strategy or "default"


def result_path_for_bundle(bundle: ReviewBundle) -> Path:
    issue_strategy = effective_issue_strategy(bundle)
    if issue_strategy != "default":
        return (
            bundle.local_root_path / f"{bundle.workflow}.{issue_strategy}-result.json"
        )
    return bundle.local_root_path / f"{bundle.workflow}-result.json"
