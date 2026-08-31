import argparse
import json
import subprocess
from pathlib import Path

from sec_review_agents.cli.local_direct import run_local_direct_workflow
from sec_review_agents.cli.local_git import (
    git_commit_exists,
    git_ref_exists,
    is_likely_git_sha,
    repo_default_branch,
)
from sec_review_agents.cli.local_materialization.common import (
    default_local_output_dir,
    result_path_for_bundle,
)
from sec_review_agents.cli.local_materialization.repository import (
    build_local_repository_security_bundle,
)
from sec_review_agents.cli.local_previewing.repository import (
    write_repository_draft_pr_previews,
)
from sec_review_agents.cli.local_temporal import run_local_temporal_workflow
from sec_review_agents.memory.store import initialize_configured_memory_store
from sec_review_agents.utils.env import bootstrap_agents_env


def _print_preview_path(result: dict, key: str, label: str) -> None:
    preview = ((result.get("previews") or {}).get(key) or {}).get("directory_path")
    if isinstance(preview, str) and preview.strip():
        print(f"{label}={preview}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize and run a local repository-review workflow."
    )
    parser.add_argument(
        "--repo", required=True, help="Path to the local repository to analyze."
    )
    parser.add_argument(
        "--scan-mode",
        choices=("full", "incremental"),
        default="full",
        help="Repository scan mode.",
    )
    parser.add_argument(
        "--target-branch",
        help="Target branch to scan. Defaults to repo default branch.",
    )
    parser.add_argument(
        "--base-sha",
        help="Incremental baseline commit SHA (7-40 hex chars). Required for incremental scans.",
    )
    parser.add_argument(
        "--head-sha",
        help="Optional incremental head commit SHA (7-40 hex chars). Defaults to target branch head.",
    )
    parser.add_argument(
        "--event-type",
        choices=("manual", "scheduled"),
        default="manual",
        help="Synthetic repository review event type.",
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
        help="Only materialize the local repository-scan input and print its path.",
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


def _resolve_incremental_refs(
    repo_path: Path,
    *,
    target_branch: str,
    base_sha_arg: str | None,
    head_sha_arg: str | None,
) -> tuple[str, str]:
    base_sha = (base_sha_arg or "").strip()
    if not base_sha:
        raise SystemExit("--base-sha is required when --scan-mode=incremental.")
    if not is_likely_git_sha(base_sha):
        raise SystemExit("--base-sha must be a valid commit SHA (7-40 hex chars).")
    if not git_commit_exists(repo_path, base_sha):
        raise SystemExit(f"--base-sha commit does not exist in repo: {base_sha}")

    head_sha = (head_sha_arg or "").strip()
    if head_sha:
        if not is_likely_git_sha(head_sha):
            raise SystemExit("--head-sha must be a valid commit SHA (7-40 hex chars).")
        if not git_commit_exists(repo_path, head_sha):
            raise SystemExit(f"--head-sha commit does not exist in repo: {head_sha}")
    else:
        head_sha = subprocess.run(
            ["git", "rev-parse", target_branch],
            cwd=repo_path,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    if base_sha.lower() == head_sha.lower():
        raise SystemExit("incremental scan requires base-sha != head-sha.")
    return base_sha, head_sha


def main() -> None:
    bootstrap_agents_env()
    initialize_configured_memory_store()
    args = parse_args()
    scan_mode = str(args.scan_mode)
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

    if scan_mode == "incremental":
        base_sha, review_ref = _resolve_incremental_refs(
            repo_path,
            target_branch=target_branch,
            base_sha_arg=args.base_sha,
            head_sha_arg=args.head_sha,
        )
    else:
        if args.base_sha or args.head_sha:
            raise SystemExit("--base-sha/--head-sha require --scan-mode=incremental.")
        base_sha = None
        review_ref = target_branch

    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else default_local_output_dir()
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    bundle = build_local_repository_security_bundle(
        repo_path=repo_path,
        output_dir=output_dir,
        repo_full_name_value=args.repo_full_name,
        ref=review_ref,
        target_branch=target_branch,
        scan_mode=scan_mode,
        baseline_ref=base_sha,
        event_type=args.event_type,
    )

    print(f"LOCAL_ROOT={bundle.input['input_bundle_uri']}")

    if args.materialize_only:
        return

    result = (
        run_local_temporal_workflow(bundle)
        if args.temporal
        else run_local_direct_workflow(bundle)
    )
    result.setdefault("previews", {})["draft_pr_preview"] = (
        write_repository_draft_pr_previews(
            materialized_input=bundle.input,
            deliveries=result.get("deliveries") or [],
            case_results=result.get("case_results") or [],
        )
    )

    result_path = result_path_for_bundle(bundle)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"WORKFLOW_RESULT={result_path}")
    _print_preview_path(result, "draft_pr_preview", "DRAFT_PR_PREVIEW")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
