import shutil
import subprocess
from pathlib import Path

from sec_review_agents.cli.local_git import (
    repo_default_branch,
    repo_full_name,
    repo_head_sha,
)
from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    build_run_paths,
    create_local_run_id,
    ensure_run_directories,
    history_path,
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


def infer_issue_from_markdown(issue_md_path: Path) -> tuple[str, str]:
    content = issue_md_path.read_text(encoding="utf-8").strip()
    lines = content.splitlines()

    if not lines:
        return "Local issue replay", ""

    first_line = lines[0].strip()
    if first_line.startswith("#"):
        title = first_line.lstrip("#").strip() or "Local issue replay"
        body = "\n".join(lines[1:]).strip()
        return title, body

    if len(lines) == 1:
        return first_line or "Local issue replay", ""

    return first_line or "Local issue replay", "\n".join(lines[1:]).strip()


def build_local_issue_bundle(
    *,
    repo_path: Path,
    title: str,
    body: str,
    issue_number: int,
    repo_full_name_value: str | None,
    output_dir: Path,
    target_branch: str | None = None,
) -> ReviewBundle:
    run_id = create_local_run_id()
    issue_number_value = str(issue_number)
    default_branch = repo_default_branch(repo_path)
    branch_for_snapshot = (target_branch or default_branch).strip() or default_branch
    ref_process = subprocess.run(
        ["git", "rev-parse", branch_for_snapshot],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    resolved_workspace_ref = ref_process.stdout.strip()
    if not resolved_workspace_ref:
        resolved_workspace_ref = repo_head_sha(repo_path).strip()

    repo_name = repo_full_name(repo_path, repo_full_name_value)
    paths = build_run_paths(output_dir, run_id)

    if paths.local_root_path.exists():
        shutil.rmtree(paths.local_root_path)

    ensure_run_directories(paths)
    workspace_root = workspace_path(paths)
    history_root = history_path(paths)

    materialize_workspace_with_limited_commit_history(
        source_repo_path=repo_path,
        workspace_path=workspace_root,
        refs=[resolved_workspace_ref],
    )
    create_workspace_snapshot_tar(
        workspace_path=workspace_root,
        tar_path=paths.local_root_path / WORKSPACE_SNAPSHOT_TAR_NAME,
    )
    write_input_bundle_manifest(paths, include_incremental_window=False)

    issue_metadata = {
        "action": "opened",
        "owner": repo_name.split("/", 1)[0],
        "repo": repo_name.split("/", 1)[-1],
        "repo_full_name": repo_name,
        "number": issue_number_value,
        "html_url": f"local://{repo_name}/issues/{issue_number_value}",
        "title": title,
        "body": body,
        "author_login": "local-user",
        "labels": [],
        "default_branch": default_branch,
    }
    write_json(history_root / "issue-metadata.json", issue_metadata)
    write_json(
        history_root / "linked-context.json",
        {
            "generated_at": utc_now_iso(),
            "relation_type": "cross-referenced",
            "source": "timeline",
            "sources_checked": ["timeline"],
            "issues": [],
            "prs": [],
        },
    )
    input_data = {
        "contract_version": "v4",
        "review_intent": {
            "objective": "repair",
            "repair_mode": "test-changes-allowed",
        },
        "issue": issue_metadata,
        "input_bundle_uri": str(paths.local_root_path),
    }
    input_path = paths.local_root_path / "issue-review-input.json"
    write_json(input_path, input_data)
    return ReviewBundle(
        workflow="issue-review",
        run_id=run_id,
        input=input_data,
        local_root_path=paths.local_root_path,
        artifact_root_path=paths.artifact_root_path,
        issue_strategy="default",
    )
