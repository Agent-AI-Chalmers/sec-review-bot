import shutil
import subprocess
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from sec_review_agents.cli.local_git import (
    repo_default_branch,
    repo_full_name,
    repo_head_sha,
)
from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    create_local_run_id,
    materialize_workspace_with_limited_commit_history,
    pack_input_bundle,
    write_input_bundle_manifest,
)
from sec_review_agents.contract_versions import EXECUTION_API_VERSION
from sec_review_agents.utils.files import write_json
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
    review_objective: str = "repair",
    test_changes: str = "allow",
    setup_declaration_content: str | None = None,
) -> ReviewBundle:
    run_id = create_local_run_id()
    # The v1 issue schema types `number` as an integer; the pull request path does the same.
    issue_number_value = int(issue_number)
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
    bundle = ReviewBundle(
        workflow="issue-review",
        run_id=run_id,
        input={},
        issue_strategy="default",
        local_root_path=output_dir / run_id,
    )

    if bundle.local_root_path.exists():
        shutil.rmtree(bundle.local_root_path)

    bundle.local_root_path.mkdir(parents=True)
    with TemporaryDirectory(prefix="sec-review-preparation-") as temporary_directory:
        preparation_root = Path(temporary_directory)
        input_root = preparation_root / "input"
        (input_root / "history").mkdir(parents=True, exist_ok=True)
        preparation_workspace = preparation_root / "workspace"
        history_root = input_root / "history"

        materialize_workspace_with_limited_commit_history(
            source_repo_path=repo_path,
            workspace_path=preparation_workspace,
            refs=[resolved_workspace_ref],
        )
        create_workspace_snapshot_tar(
            workspace_path=preparation_workspace,
            tar_path=input_root / WORKSPACE_SNAPSHOT_TAR_NAME,
        )
        write_input_bundle_manifest(input_root, include_incremental_window=False)

        # Input preparation validates this against the v1 issue schema, which forbids additional
        # properties, so it carries identity plus what the prompts render and nothing else.
        issue_metadata = {
            "owner": repo_name.split("/", 1)[0],
            "repo": repo_name.split("/", 1)[-1],
            "repo_full_name": repo_name,
            "number": issue_number_value,
            "title": title,
            "body": body,
        }
        write_json(history_root / "issue-metadata.json", issue_metadata)
        write_json(
            history_root / "linked-context.json",
            {
                "relation_type": "cross-referenced",
                "source": "timeline",
                "sources_checked": ["timeline"],
                "issues": [],
                "prs": [],
            },
        )
        input_bundle = pack_input_bundle(
            bundle, input_root=input_root, include_incremental_window=False
        )
    input_data = {
        "api_version": EXECUTION_API_VERSION,
        "review_intent": {
            "objective": review_objective,
            "test_changes": test_changes,
        },
        "issue": issue_metadata,
        "input_bundle": input_bundle,
        **(
            {"setup_declaration": setup_declaration_content}
            if setup_declaration_content is not None
            else {}
        ),
    }
    input_path = bundle.local_root_path / "issue-review-input.json"
    write_json(input_path, input_data)
    return replace(bundle, input=input_data)
