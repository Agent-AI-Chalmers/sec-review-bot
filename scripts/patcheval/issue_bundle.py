import shutil
from pathlib import Path

from scripts.patcheval.dataset import (
    PatchevalCase,
    PatchevalIssueMode,
    load_patcheval_case,
)
from scripts.patcheval.workspace_seed import materialize_patcheval_workspace
from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    build_run_paths,
    create_local_run_id,
    ensure_run_directories,
    history_path,
    initialize_workspace_git_repo,
    workspace_path,
    write_input_bundle_manifest,
)
from sec_review_agents.utils.files import write_json
from sec_review_agents.utils.time import utc_now_iso
from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
)


def build_patcheval_issue_bundle(
    *,
    cve_id: str,
    dataset_path: str | Path,
    output_dir: Path,
    location_oracle: bool = False,
    two_stage: bool = False,
    single_agent: bool = False,
) -> ReviewBundle:
    case = load_patcheval_case(
        cve_id=cve_id,
        dataset_path=dataset_path,
    )
    return build_patcheval_issue_bundle_from_case(
        case=case,
        output_dir=output_dir,
        location_oracle=location_oracle,
        two_stage=two_stage,
        single_agent=single_agent,
    )


def build_patcheval_issue_bundle_from_case(
    *,
    case: PatchevalCase,
    output_dir: Path,
    location_oracle: bool = False,
    two_stage: bool = False,
    single_agent: bool = False,
) -> ReviewBundle:
    issue_mode: PatchevalIssueMode = (
        "location_oracle" if location_oracle else "end_to_end"
    )
    run_id = create_local_run_id()
    issue_number_value = "1"
    public_repo_name = f"local/{case.repo_name}"
    default_branch = None
    paths = build_run_paths(output_dir, run_id)

    if paths.local_root_path.exists():
        shutil.rmtree(paths.local_root_path)

    history_root = history_path(paths)
    ensure_run_directories(paths)
    repo_root = materialize_patcheval_workspace(
        image_name=case.image_name,
        work_dir=case.work_dir,
        destination_root=workspace_path(paths),
    )
    initialize_workspace_git_repo(repo_root)
    create_workspace_snapshot_tar(
        workspace_path=repo_root,
        tar_path=paths.local_root_path / WORKSPACE_SNAPSHOT_TAR_NAME,
    )
    shutil.rmtree(workspace_path(paths), ignore_errors=True)
    write_input_bundle_manifest(paths, include_incremental_window=False)

    issue_metadata = {
        "action": "opened",
        "owner": public_repo_name.split("/", 1)[0],
        "repo": public_repo_name.split("/", 1)[-1],
        "repo_full_name": public_repo_name,
        "number": issue_number_value,
        "html_url": f"local://issue/{issue_number_value}",
        "title": case.issue_title(issue_mode),
        "body": case.issue_body(issue_mode),
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
            "repair_mode": "no-test-changes",
        },
        "issue": issue_metadata,
        "input_bundle_uri": str(paths.local_root_path),
    }
    input_path = paths.local_root_path / "issue-review-input.json"
    write_json(input_path, input_data)
    bundle_kwargs = {
        "workflow": "issue-review",
        "run_id": run_id,
        "input": input_data,
        "local_root_path": paths.local_root_path,
        "artifact_root_path": paths.artifact_root_path,
        "runtime_config": {
            "workspace_image": case.image_name,
        },
    }
    if two_stage:
        return ReviewBundle(**bundle_kwargs, issue_strategy="two-stage")
    if single_agent:
        return ReviewBundle(**bundle_kwargs, issue_strategy="single-agent")
    return ReviewBundle(**bundle_kwargs, issue_strategy="default")
