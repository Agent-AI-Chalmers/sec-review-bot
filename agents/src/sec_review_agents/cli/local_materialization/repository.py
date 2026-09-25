import shutil
import subprocess
from pathlib import Path

from sec_review_agents.cli.local_git import repo_default_branch, resolve_git_ref
from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    build_run_paths,
    create_local_run_id,
    ensure_run_directories,
    history_path,
    incremental_window_path,
    materialize_workspace_with_limited_commit_history,
    workspace_path,
    write_input_bundle_manifest,
)
from sec_review_agents.utils.files import write_json
from sec_review_agents.utils.time import utc_now_iso
from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
)


def _normalize_scan_mode(value: str | None) -> str:
    raw = (value or "").strip().lower()
    if raw in {"full", "incremental"}:
        return raw
    raise ValueError(
        f"Unsupported scan_mode '{value}'. Expected 'full' or 'incremental'."
    )


def _is_ancestor_commit(repo_path: Path, base_ref: str, head_ref: str) -> bool:
    process = subprocess.run(
        ["git", "merge-base", "--is-ancestor", base_ref, head_ref],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    return process.returncode == 0


def _build_changed_files(repo_path: Path, base_ref: str, head_ref: str) -> list[dict]:
    output = subprocess.run(
        ["git", "diff", "--name-status", "-M", f"{base_ref}..{head_ref}"],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    files: list[dict] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status_raw = (parts[0] if len(parts) > 0 else "").strip()
        if not status_raw:
            continue
        previous_path: str | None = None
        current_path = (parts[1] if len(parts) > 1 else "").strip()
        if status_raw.startswith(("R", "C")):
            previous_path = (parts[1] if len(parts) > 1 else "").strip() or None
            current_path = (parts[2] if len(parts) > 2 else "").strip()
        if not current_path:
            continue
        if status_raw.startswith("R"):
            status = "renamed"
        elif status_raw.startswith("A"):
            status = "added"
        elif status_raw.startswith("D"):
            status = "deleted"
        else:
            status = "modified"
        files.append(
            {
                "path": current_path,
                "status": status,
                "previous_path": previous_path,
            }
        )
    files.sort(key=lambda item: str(item.get("path") or ""))
    return files


def _materialize_incremental_artifacts(
    *,
    repo_path: Path,
    paths,
    run_id: str,
    event_type: str,
    base_ref: str,
    head_ref: str,
) -> tuple[list[dict], list[str]]:
    incremental_window_root = incremental_window_path(paths)
    history_root = history_path(paths)
    patch_text = subprocess.run(
        ["git", "diff", "--binary", f"{base_ref}..{head_ref}"],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    incremental_window_root.mkdir(parents=True, exist_ok=True)
    history_root.mkdir(parents=True, exist_ok=True)
    (incremental_window_root / "incremental.patch").write_text(
        patch_text, encoding="utf-8"
    )

    changed_files = _build_changed_files(repo_path, base_ref, head_ref)
    write_json(
        incremental_window_root / "changed-files.json",
        {
            "base_sha": base_ref,
            "head_sha": head_ref,
            "files": changed_files,
        },
    )

    commits_output = subprocess.run(
        [
            "git",
            "log",
            "--no-merges",
            "--date=iso-strict",
            "--pretty=format:%H%x09%s%x09%an%x09%cI",
            f"{base_ref}..{head_ref}",
        ],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    commits = []
    for line in commits_output.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        commits.append(
            {
                "sha": (parts[0] if len(parts) > 0 else "").strip(),
                "title": (parts[1] if len(parts) > 1 else "").strip(),
                "author": (parts[2] if len(parts) > 2 else "").strip(),
                "committed_at": (parts[3] if len(parts) > 3 else "").strip(),
            }
        )
    filtered_commits = [item for item in commits if item["sha"]]
    write_json(
        history_root / "commits.json",
        {
            "base_sha": base_ref,
            "head_sha": head_ref,
            "commits": filtered_commits,
        },
    )
    write_json(
        history_root / "scan-window.json",
        {
            "run_id": run_id,
            "event_type": event_type,
            "scan_mode": "incremental",
            "base_sha": base_ref,
            "head_sha": head_ref,
            "changed_file_count": len(changed_files),
            "generated_at": utc_now_iso(),
        },
    )
    return changed_files, [item["sha"] for item in filtered_commits]


def build_local_repository_security_bundle(
    *,
    repo_path: Path,
    output_dir: Path,
    repo_full_name_value: str | None,
    ref: str = "HEAD",
    target_branch: str | None = None,
    scan_mode: str = "full",
    baseline_ref: str | None = None,
    event_type: str = "manual",
    default_branch: str | None = None,
    repair_mode: str = "test-changes-allowed",
) -> ReviewBundle:
    run_id = create_local_run_id()
    resolved_ref = resolve_git_ref(repo_path, ref)
    resolved_default_branch = default_branch or repo_default_branch(repo_path)
    paths = build_run_paths(output_dir, run_id)

    if paths.local_root_path.exists():
        shutil.rmtree(paths.local_root_path)

    ensure_run_directories(
        paths,
        include_repository_artifacts=True,
    )

    resolved_scan_mode = _normalize_scan_mode(scan_mode)
    base_ref: str | None = None
    changed_files_for_manifest: list[dict] = []
    commit_shas_for_scan_target: list[str] = []
    if resolved_scan_mode == "incremental":
        baseline_candidate = (baseline_ref or "").strip()
        if not baseline_candidate:
            raise ValueError(
                "Incremental scan requested but no baseline_ref was provided. "
                "Refusing to silently downgrade to full scan."
            )
        else:
            base_ref = resolve_git_ref(repo_path, baseline_candidate)
            if base_ref == resolved_ref:
                raise ValueError(
                    "Incremental scan requested but baseline resolves to the same commit as head. "
                    "Refusing to silently downgrade to full scan."
                )
            if not _is_ancestor_commit(repo_path, base_ref, resolved_ref):
                raise ValueError(
                    "Incremental scan requested but baseline is not an ancestor of head. "
                    "Refusing to silently downgrade to full scan."
                )
            try:
                changed_files_for_manifest, commit_shas_for_scan_target = (
                    _materialize_incremental_artifacts(
                        repo_path=repo_path,
                        paths=paths,
                        run_id=run_id,
                        event_type=event_type,
                        base_ref=base_ref,
                        head_ref=resolved_ref,
                    )
                )
            except Exception as error:
                raise RuntimeError(
                    "Incremental scan requested but incremental artifacts could not be generated. "
                    "Refusing to silently downgrade to full scan."
                ) from error

    limited_refs = [base_ref] if base_ref else []
    limited_refs.append(resolved_ref)
    materialize_workspace_with_limited_commit_history(
        source_repo_path=repo_path,
        workspace_path=workspace_path(paths),
        refs=limited_refs,
    )

    create_workspace_snapshot_tar(
        workspace_path=workspace_path(paths),
        tar_path=paths.local_root_path / WORKSPACE_SNAPSHOT_TAR_NAME,
    )
    write_input_bundle_manifest(
        paths,
        include_incremental_window=(resolved_scan_mode == "incremental"),
    )

    if resolved_scan_mode == "full":
        write_json(
            history_path(paths) / "scan-window.json",
            {
                "run_id": run_id,
                "event_type": event_type,
                "scan_mode": "full",
                "base_sha": base_ref,
                "head_sha": resolved_ref,
                "generated_at": utc_now_iso(),
            },
        )

    scan_scope = {
        "max_file_bytes": 200_000,
        "paths_ignore": [],
        "incremental_changed_files": [
            {
                "path": item.get("path"),
                "status": item.get("status"),
                "previous_path": item.get("previous_path"),
            }
            for item in changed_files_for_manifest
        ],
    }

    input_data = {
        "contract_version": "v4",
        "input_bundle_uri": str(paths.local_root_path),
        "review_intent": {
            "objective": "audit",
            "repair_mode": repair_mode,
        },
        "scan_target": {
            "target_branch": (target_branch or ref),
            "default_branch": resolved_default_branch,
            "event_type": event_type,
            "scan_mode": resolved_scan_mode,
            "base_sha": base_ref,
            "head_sha": resolved_ref,
            "commit_shas": commit_shas_for_scan_target,
        },
        "scan_scope": scan_scope,
    }
    input_path = paths.local_root_path / "repository-review-input.json"
    write_json(input_path, input_data)

    return ReviewBundle(
        workflow="repository-review",
        run_id=run_id,
        input=input_data,
        local_root_path=paths.local_root_path,
        artifact_root_path=paths.artifact_root_path,
    )
