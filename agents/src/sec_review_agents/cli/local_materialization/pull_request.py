import shutil
import subprocess
from pathlib import Path
from typing import Any

from sec_review_agents.cli.local_git import repo_full_name, resolve_git_ref
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


def _parse_markdown_title_and_body(markdown_path: Path) -> tuple[str, str]:
    content = markdown_path.read_text(encoding="utf-8").strip()
    lines = content.splitlines()

    if not lines:
        return "Local pull request replay", ""

    first_line = lines[0].strip()
    if first_line.startswith("#"):
        title = first_line.lstrip("#").strip() or "Local pull request replay"
        body = "\n".join(lines[1:]).strip()
        return title, body

    if len(lines) == 1:
        return first_line or "Local pull request replay", ""

    return first_line or "Local pull request replay", "\n".join(lines[1:]).strip()


def infer_pull_request_from_markdown(pr_md_path: Path) -> tuple[str, str]:
    return _parse_markdown_title_and_body(pr_md_path)


def _normalize_file_status(raw_status: str) -> str:
    status_code = raw_status[:1]
    return {
        "A": "added",
        "C": "copied",
        "D": "removed",
        "M": "modified",
        "R": "renamed",
        "T": "changed",
        "U": "modified",
        "X": "modified",
        "B": "modified",
    }.get(status_code, "modified")


def _parse_name_status_records(diff_output: str) -> list[dict[str, str | None]]:
    tokens = [token for token in diff_output.split("\0") if token]
    entries: list[dict[str, str | None]] = []
    index = 0

    while index < len(tokens):
        raw_status = tokens[index]
        index += 1

        previous_path: str | None = None
        if raw_status.startswith(("R", "C")):
            if index + 1 >= len(tokens):
                raise ValueError(f"Malformed git name-status output for {raw_status!r}")
            previous_path = tokens[index]
            current_path = tokens[index + 1]
            index += 2
        else:
            if index >= len(tokens):
                raise ValueError(f"Malformed git name-status output for {raw_status!r}")
            current_path = tokens[index]
            index += 1

        entries.append(
            {
                "raw_status": raw_status,
                "status": _normalize_file_status(raw_status),
                "path": current_path,
                "previous_path": previous_path,
            }
        )

    return entries


def _count_patch_changes(patch_text: str) -> tuple[int, int]:
    additions = 0
    deletions = 0

    for line in patch_text.splitlines():
        if line.startswith(("+++", "---")):
            continue
        if line.startswith("+"):
            additions += 1
        elif line.startswith("-"):
            deletions += 1

    return additions, deletions


def _build_incremental_patch(files: list[dict[str, Any]]) -> str:
    chunks: list[str] = []

    for file in files:
        patch = file.get("patch")
        file_path = str(file.get("filename") or "")
        if not isinstance(patch, str) or not patch.strip() or not file_path:
            continue

        chunks.extend(
            [
                f"diff --git a/{file_path} b/{file_path}",
                f"--- a/{file_path}",
                f"+++ b/{file_path}",
                patch,
            ]
        )

    return "\n".join(chunks)


def _build_local_pr_files(repo_path: Path, diff_range: str) -> list[dict[str, Any]]:
    raw_name_status = subprocess.run(
        [
            "git",
            "diff",
            "--find-renames",
            "--find-copies",
            "--name-status",
            "-z",
            diff_range,
        ],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    entries = _parse_name_status_records(raw_name_status)
    files: list[dict[str, Any]] = []

    for entry in entries:
        file_path = str(entry["path"])
        patch_text = subprocess.run(
            [
                "git",
                "diff",
                "--find-renames",
                "--find-copies",
                "--unified=3",
                "--no-color",
                diff_range,
                "--",
                file_path,
            ],
            cwd=repo_path,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        normalized_patch = patch_text.strip() or None
        additions, deletions = _count_patch_changes(normalized_patch or "")

        files.append(
            {
                "filename": file_path,
                "status": entry["status"],
                "additions": additions,
                "deletions": deletions,
                "changes": additions + deletions,
                "patch": normalized_patch,
                "blob_url": None,
                "raw_url": None,
                "previous_filename": entry["previous_path"],
            }
        )

    return files


def _materialize_incremental_window_artifacts(
    files: list[dict[str, Any]], incremental_window_path: Path
) -> None:
    changed_files = [
        {
            "path": file["filename"],
            "status": file["status"],
            "previous_path": file.get("previous_filename"),
            "additions": file["additions"],
            "deletions": file["deletions"],
            "changes": file["changes"],
        }
        for file in files
    ]

    (incremental_window_path / "incremental.patch").write_text(
        _build_incremental_patch(files), encoding="utf-8"
    )
    write_json(
        incremental_window_path / "changed-files.json",
        {
            "generated_at": utc_now_iso(),
            "files": changed_files,
        },
    )


def build_local_pull_request_bundle(
    *,
    repo_path: Path,
    title: str,
    body: str,
    pr_number: int,
    repo_full_name_value: str | None,
    output_dir: Path,
    base_ref: str,
    head_ref: str = "HEAD",
    event_type: str = "local_review",
    is_draft: bool = False,
) -> ReviewBundle:
    run_id = create_local_run_id()
    pr_number_value = int(pr_number)
    repo_name = repo_full_name(repo_path, repo_full_name_value)
    owner_login, repo_short_name = repo_name.split("/", 1)
    base_sha = resolve_git_ref(repo_path, base_ref)
    head_sha = resolve_git_ref(repo_path, head_ref)
    diff_range = f"{base_ref}...{head_ref}"
    files = _build_local_pr_files(repo_path, diff_range)
    manifest_paths = build_run_paths(output_dir, run_id)

    if manifest_paths.local_root_path.exists():
        shutil.rmtree(manifest_paths.local_root_path)

    workspace_root = workspace_path(manifest_paths)
    incremental_window_root = incremental_window_path(manifest_paths)
    history_root = history_path(manifest_paths)

    ensure_run_directories(manifest_paths)
    incremental_window_root.mkdir(parents=True, exist_ok=True)
    materialize_workspace_with_limited_commit_history(
        source_repo_path=repo_path,
        workspace_path=workspace_root,
        refs=[base_sha, head_sha],
    )
    create_workspace_snapshot_tar(
        workspace_path=workspace_root,
        tar_path=manifest_paths.local_root_path / WORKSPACE_SNAPSHOT_TAR_NAME,
    )
    write_input_bundle_manifest(manifest_paths, include_incremental_window=True)

    _materialize_incremental_window_artifacts(files, incremental_window_root)
    linked_issues = {
        "generated_at": utc_now_iso(),
        "relation_type": "cross-referenced",
        "source": "timeline",
        "sources_checked": ["timeline"],
        "issues": [],
        "prs": [],
    }

    commit_count_output = subprocess.run(
        ["git", "rev-list", "--count", f"{base_sha}..{head_sha}"],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    ).stdout.strip()
    commit_count = int(commit_count_output or "0")
    commit_shas_output = subprocess.run(
        ["git", "rev-list", f"{base_sha}..{head_sha}"],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    ).stdout
    commit_shas = [
        line.strip() for line in commit_shas_output.splitlines() if line.strip()
    ]
    additions = sum(file["additions"] for file in files)
    deletions = sum(file["deletions"] for file in files)

    pr_metadata = {
        "action": event_type,
        "owner": owner_login,
        "repo": repo_short_name,
        "repo_full_name": repo_name,
        "number": pr_number_value,
        "html_url": f"local://{repo_name}/pull/{pr_number_value}",
        "title": title,
        "body": body,
        "author_login": "local-user",
        "is_draft": is_draft,
        "base_ref": base_ref,
        "base_sha": base_sha,
        "head_ref": head_ref,
        "head_sha": head_sha,
        "commit_shas": commit_shas,
        "previous_head_sha": None,
        "commits": commit_count,
        "changed_files": len(files),
        "additions": additions,
        "deletions": deletions,
    }

    write_json(history_root / "pr-metadata.json", pr_metadata)
    write_json(history_root / "linked-context.json", linked_issues)

    input_data = {
        "contract_version": "v4",
        "review_intent": {"objective": "audit"},
        "pr": pr_metadata,
        "input_bundle_uri": str(manifest_paths.local_root_path),
    }

    input_path = manifest_paths.local_root_path / "pull-request-review-input.json"
    write_json(input_path, input_data)
    return ReviewBundle(
        workflow="pull-request-review",
        run_id=run_id,
        input=input_data,
        local_root_path=manifest_paths.local_root_path,
        artifact_root_path=manifest_paths.artifact_root_path,
    )
