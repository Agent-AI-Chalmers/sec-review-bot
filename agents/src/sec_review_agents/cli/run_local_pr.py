import argparse
import json
from pathlib import Path

from sec_review_agents.cli.local_direct import run_local_direct_workflow
from sec_review_agents.cli.local_git import git_commit_exists, is_likely_git_sha
from sec_review_agents.cli.local_materialization.common import (
    default_local_output_dir,
    result_path_for_bundle,
)
from sec_review_agents.cli.local_materialization.pull_request import (
    build_local_pull_request_bundle,
    infer_pull_request_from_markdown,
)
from sec_review_agents.cli.local_previewing.pull_request import (
    write_pull_request_previews,
)
from sec_review_agents.cli.local_temporal import run_local_temporal_workflow
from sec_review_agents.memory.store import initialize_configured_memory_store
from sec_review_agents.utils.env import bootstrap_agents_env


def _resolve_pull_request_text(args: argparse.Namespace) -> tuple[str, str]:
    if args.pr_md:
        return infer_pull_request_from_markdown(Path(args.pr_md))

    body = (
        Path(args.body_file).read_text(encoding="utf-8")
        if args.body_file
        else (args.body or "")
    )
    title = args.title or "Local pull request replay"
    return title, body


def _print_preview_path(result: dict, key: str, label: str) -> None:
    preview = ((result.get("previews") or {}).get(key) or {}).get("directory_path")
    if isinstance(preview, str) and preview.strip():
        print(f"{label}={preview}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize and run a local pull-request-review workflow."
    )
    parser.add_argument(
        "--repo", required=True, help="Path to the local repository to analyze."
    )
    parser.add_argument(
        "--pr-md",
        help="Markdown file describing the pull request. First heading or line becomes the title.",
    )
    parser.add_argument("--title", help="Pull request title when not using --pr-md.")
    parser.add_argument(
        "--body", help="Pull request body text when not using --pr-md or --body-file."
    )
    parser.add_argument(
        "--body-file", help="Path to a file containing the pull request body."
    )
    parser.add_argument(
        "--pr-number", type=int, default=1, help="Synthetic local pull request number."
    )
    parser.add_argument(
        "--repo-full-name",
        help="Synthetic repo full name, defaults to local/<repo-name>.",
    )
    parser.add_argument(
        "--base-sha",
        required=True,
        help="Base commit SHA for the local PR diff (7-40 hex chars).",
    )
    parser.add_argument(
        "--head-sha",
        required=True,
        help="Head commit SHA for the local PR diff (7-40 hex chars).",
    )
    parser.add_argument(
        "--event-type",
        default="local_review",
        help="Synthetic PR event type passed to the workflow.",
    )
    parser.add_argument(
        "--draft",
        action="store_true",
        help="Mark the synthetic local pull request as draft.",
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
        help="Only materialize the local pull-request input and print its path.",
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
    repo_path = Path(args.repo).resolve()

    if not repo_path.exists() or not repo_path.is_dir():
        raise SystemExit(f"--repo does not exist or is not a directory: {repo_path}")

    base_sha = args.base_sha.strip()
    head_sha = args.head_sha.strip()
    if not is_likely_git_sha(base_sha):
        raise SystemExit("--base-sha must be a valid commit SHA (7-40 hex chars).")
    if not is_likely_git_sha(head_sha):
        raise SystemExit("--head-sha must be a valid commit SHA (7-40 hex chars).")
    if base_sha.lower() == head_sha.lower():
        raise SystemExit("pull-request review requires base-sha != head-sha.")
    if not git_commit_exists(repo_path, base_sha):
        raise SystemExit(f"--base-sha commit does not exist in repo: {base_sha}")
    if not git_commit_exists(repo_path, head_sha):
        raise SystemExit(f"--head-sha commit does not exist in repo: {head_sha}")

    if not args.pr_md and not args.title and not args.body and not args.body_file:
        raise SystemExit("Provide --pr-md or at least --title/--body.")

    title, body = _resolve_pull_request_text(args)
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else default_local_output_dir()
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    bundle = build_local_pull_request_bundle(
        repo_path=repo_path,
        title=title,
        body=body,
        pr_number=args.pr_number,
        repo_full_name_value=args.repo_full_name,
        output_dir=output_dir,
        base_ref=base_sha,
        head_ref=head_sha,
        event_type=args.event_type,
        is_draft=args.draft,
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
    result.setdefault("previews", {})["pull_request_preview"] = (
        write_pull_request_previews(
            materialized_input=bundle.input,
            workflow_result=result,
        )
    )

    result_path = result_path_for_bundle(bundle)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"WORKFLOW_RESULT={result_path}")
    _print_preview_path(
        result,
        "pull_request_preview",
        "PULL_REQUEST_PREVIEW",
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
