import argparse
import json
from pathlib import Path

from sec_review_agents.cli.local_direct import run_local_direct_workflow
from sec_review_agents.cli.local_git import git_ref_exists, repo_default_branch
from sec_review_agents.cli.local_materialization.common import (
    IssueReviewStrategy,
    ReviewBundle,
    default_local_output_dir,
    result_path_for_bundle,
)
from sec_review_agents.cli.local_materialization.issue import (
    build_local_issue_bundle,
    infer_issue_from_markdown,
)
from sec_review_agents.cli.local_previewing.issue import (
    write_issue_previews,
)
from sec_review_agents.cli.local_temporal import run_local_temporal_workflow
from sec_review_agents.memory.store import initialize_configured_memory_store
from sec_review_agents.utils.env import bootstrap_agents_env


def _resolve_issue_text(args: argparse.Namespace) -> tuple[str, str]:
    if args.issue_md:
        return infer_issue_from_markdown(Path(args.issue_md))

    body = (
        Path(args.body_file).read_text(encoding="utf-8")
        if args.body_file
        else (args.body or "")
    )
    title = args.title or "Local issue replay"
    return title, body


def _print_preview_path(result: dict, key: str, label: str) -> None:
    preview = ((result.get("previews") or {}).get(key) or {}).get("directory_path")
    if isinstance(preview, str) and preview.strip():
        print(f"{label}={preview}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize and run a local issue-review workflow."
    )
    parser.add_argument(
        "--strategy",
        choices=("default", "two-stage", "single-agent"),
        default="default",
        help="Local issue strategy to run.",
    )
    parser.add_argument(
        "--repo", required=True, help="Path to the local repository to analyze."
    )
    parser.add_argument(
        "--issue-md",
        help="Markdown file describing the issue. First heading or line becomes the title.",
    )
    parser.add_argument("--title", help="Issue title when not using --issue-md.")
    parser.add_argument(
        "--body", help="Issue body text when not using --issue-md or --body-file."
    )
    parser.add_argument("--body-file", help="Path to a file containing the issue body.")
    parser.add_argument(
        "--issue-number", type=int, default=1, help="Synthetic local issue number."
    )
    parser.add_argument(
        "--target-branch",
        help="Target branch to snapshot. Defaults to repo default branch.",
    )
    parser.add_argument(
        "--repo-full-name",
        help="Synthetic repo full name, defaults to local/<repo-name>.",
    )
    parser.add_argument(
        "--output-dir",
        help=(
            "Directory where materialized local run roots should be created. "
            "Defaults to a temp root."
        ),
    )
    parser.add_argument(
        "--materialize-only",
        action="store_true",
        help="Only materialize the local issue input and print its path.",
    )
    parser.add_argument(
        "--temporal",
        action="store_true",
        help=(
            "Run through local Temporal instead of the default direct runner. "
            "The default direct runner is for local replay and does not provide "
            "Temporal retries, scheduling, or failure handling."
        ),
    )
    return parser.parse_args()


def main() -> None:
    bootstrap_agents_env()
    initialize_configured_memory_store()
    args = parse_args()
    issue_strategy: IssueReviewStrategy = args.strategy
    repo_path = Path(args.repo).resolve()

    if not repo_path.exists() or not repo_path.is_dir():
        raise SystemExit(f"--repo does not exist or is not a directory: {repo_path}")

    target_branch = (args.target_branch or repo_default_branch(repo_path)).strip()
    if not target_branch:
        raise SystemExit(
            "Unable to resolve target branch. Provide --target-branch explicitly."
        )
    if not git_ref_exists(repo_path, target_branch):
        raise SystemExit(
            f"--target-branch does not resolve to a commit in repo: {target_branch}"
        )

    if not args.issue_md and not args.title and not args.body and not args.body_file:
        raise SystemExit("Provide --issue-md or at least --title/--body.")

    title, body = _resolve_issue_text(args)
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else default_local_output_dir()
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    bundle = build_local_issue_bundle(
        repo_path=repo_path,
        title=title,
        body=body,
        issue_number=args.issue_number,
        repo_full_name_value=args.repo_full_name,
        output_dir=output_dir,
        target_branch=target_branch,
    )
    bundle = ReviewBundle(
        workflow="issue-review",
        run_id=bundle.run_id,
        input=bundle.input,
        local_root_path=bundle.local_root_path,
        artifact_root_path=bundle.artifact_root_path,
        runtime_config=bundle.runtime_config,
        issue_strategy=issue_strategy,
    )

    print(f"LOCAL_ROOT={bundle.input['input_bundle_uri']}")

    if args.materialize_only:
        return

    workflow_result = (
        run_local_temporal_workflow(bundle)
        if args.temporal
        else run_local_direct_workflow(bundle)
    )
    result = workflow_result
    result.setdefault("previews", {})["issue_preview"] = write_issue_previews(
        materialized_input=bundle.input,
        workflow_result=result,
    )

    result_path = result_path_for_bundle(bundle)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"WORKFLOW_RESULT={result_path}")
    _print_preview_path(result, "issue_preview", "ISSUE_PREVIEW")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
