# Experimental replay script. It may be destructive, may not track the latest
# package contracts, and may not fit current run artifacts. Results are not
# guaranteed; inspect the target artifacts and adjust this script before use.

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from sec_review_agents.review_stages.transcripts import (
    review_transcripts_root,
)
from sec_review_agents.temporal.config import DEFAULT_WORKFLOW_TIMEOUT_SECONDS
from sec_review_agents.utils.env import (
    bool_env,
    bootstrap_agents_env,
    env_value,
    int_env,
)
from sec_review_agents.utils.files import persist_json_artifact
from sec_review_agents.workflows.repository.case_execution_input import (
    prepare_case_execution_input,
    window_deletion_summary,
)
from sec_review_agents.workflows.repository.result import (
    build_repository_workflow_result,
)
from sec_review_agents.workflows.repository.workflow import (
    RepositoryCaseReviewRequest,
    resolve_repository_case_processing_max_concurrency,
)
from sec_review_agents.workflows.repository_case.direct import (
    run_repository_case_review_direct,
)
from sec_review_agents.workflows.review_intent import require_review_intent

from scripts.replay.input_bundle import (
    materialize_replay_input,
    read_json,
    read_replay_bundle_paths,
)

ENV_RUN_ARTIFACTS_PATH = "REPOSITORY_CASE_PROCESSING_RUN_ARTIFACTS_PATH"
ENV_INPUT_PATH = "REPOSITORY_CASE_PROCESSING_INPUT_PATH"
ENV_DISCOVERY_PATH = "REPOSITORY_CASE_PROCESSING_DISCOVERY_PATH"
ENV_TRIAGE_PATH = "REPOSITORY_CASE_PROCESSING_TRIAGE_PATH"
ENV_START = "REPOSITORY_CASE_PROCESSING_START"
ENV_LIMIT = "REPOSITORY_CASE_PROCESSING_LIMIT"
ENV_RERUN_EXISTING = "REPOSITORY_CASE_PROCESSING_RERUN_EXISTING"


def _resolve_input_path(run_artifacts: Path, input_path: str | None) -> Path:
    if input_path:
        return Path(input_path).resolve()
    return run_artifacts.parent.parent / "repository-review-input.json"


def _load_existing_result(run_artifacts: Path) -> dict[str, Any] | None:
    result_path = run_artifacts / "repository-review-result.json"
    if not result_path.exists():
        return None
    result = read_json(result_path)
    return result if isinstance(result.get("case_results"), list) else None


def _window_deletions(
    *,
    existing_result: dict[str, Any],
    replay_input: dict[str, Any],
) -> dict[str, Any]:
    """Return the window's deletion reading for the rebuilt result.

    Neither discovery nor triage sees a deletion, so rebuilding from those stages alone would
    report zero deleted files and an unreviewed window as reviewed. The previous result is
    therefore the source of truth when it exists, and is cross-checked against the window the
    run was started with: a disagreement means the artifacts describe different windows, which
    is not something to paper over. With no previous result -- the first run of this replay --
    the reading is recomputed from that same window.
    """
    recomputed = window_deletion_summary(
        scan_scope=replay_input.get("scan_scope") or {},
        scan_mode=str((replay_input.get("scan_target") or {}).get("scan_mode") or ""),
    )
    scan_summary = existing_result.get("scan_summary")
    deleted_file_count = (
        scan_summary.get("deleted_file_count")
        if isinstance(scan_summary, dict)
        else None
    )
    skipped = existing_result.get("deletion_review_skipped")
    if deleted_file_count is None and skipped is None:
        return recomputed
    if (
        isinstance(deleted_file_count, bool)
        or not isinstance(deleted_file_count, int)
        or not isinstance(skipped, bool)
    ):
        raise TypeError(
            "Repository result carries an incomplete deletion reading "
            "(scan_summary.deleted_file_count, deletion_review_skipped); "
            "replay cannot tell whether deletion review ran"
        )
    if (
        deleted_file_count != recomputed["deleted_file_count"]
        or skipped != recomputed["deletion_review_skipped"]
    ):
        raise ValueError(
            "Repository result disagrees with the window it was started from: "
            f"result says {deleted_file_count} deleted / skipped={skipped}, "
            f"window says {recomputed['deleted_file_count']} deleted / "
            f"skipped={recomputed['deletion_review_skipped']}"
        )
    return {
        "deleted_file_count": deleted_file_count,
        "deletion_review_skipped": skipped,
    }


def _case_id(case: dict[str, Any]) -> str:
    return str(case.get("case_id") or "").strip()


def _case_result_id(case_result: dict[str, Any]) -> str:
    return str(case_result.get("case_id") or "").strip()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run repository-review case-processing only from existing "
            "discovery/triage artifacts. Supports ranged reruns for quota-limited runs."
        )
    )
    parser.add_argument(
        "--run-artifacts-path",
        default=env_value(ENV_RUN_ARTIFACTS_PATH),
        help=(
            "Path to artifacts/run-... directory. Env: " f"{ENV_RUN_ARTIFACTS_PATH}."
        ),
    )
    parser.add_argument(
        "--input-path",
        default=env_value(ENV_INPUT_PATH),
        help=(
            "Optional repository-review-input.json path. Defaults to "
            f"<workspace-root>/repository-review-input.json. Env: {ENV_INPUT_PATH}."
        ),
    )
    parser.add_argument(
        "--discovery-path",
        default=env_value(ENV_DISCOVERY_PATH),
        help=(
            "Optional discovery-result.json path. Defaults to "
            f"<run-artifacts-path>/discovery/discovery-result.json. Env: {ENV_DISCOVERY_PATH}."
        ),
    )
    parser.add_argument(
        "--triage-path",
        default=env_value(ENV_TRIAGE_PATH),
        help=(
            "Optional triage-result.json path. Defaults to "
            f"<run-artifacts-path>/triage/triage-result.json. Env: {ENV_TRIAGE_PATH}."
        ),
    )
    parser.add_argument(
        "--start",
        type=int,
        default=int_env(ENV_START, 1, minimum=1),
        help=f"1-based case ordinal to start from. Env: {ENV_START}.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=int_env(ENV_LIMIT, None, minimum=1),
        help=f"Maximum number of cases to process in this invocation. Env: {ENV_LIMIT}.",
    )
    parser.add_argument(
        "--rerun-existing",
        action=argparse.BooleanOptionalAction,
        default=bool_env(ENV_RERUN_EXISTING, False),
        help="Rerun cases even when an existing result already has a result for the case.",
    )
    return parser.parse_args()


def _case_review_request(
    *,
    run_id: str,
    bundle_paths: dict[str, Path],
    cases_artifacts_path: str,
    scan_mode: str,
    test_changes: Any,
    case: dict[str, Any],
) -> RepositoryCaseReviewRequest:
    case_execution_input = prepare_case_execution_input(
        workspace_snapshot_tar_path=bundle_paths["workspace_snapshot_tar_path"],
        history_path=bundle_paths["history_path"],
        incremental_window_path=bundle_paths.get("incremental_window_path"),
        scan_mode=scan_mode,
        case=case,
        test_changes=test_changes,
    )
    return {
        "run_id": run_id,
        "case_execution_input": case_execution_input,
        "cases_artifacts_path": cases_artifacts_path,
        "published_transcripts_path": str(
            review_transcripts_root(
                Path(cases_artifacts_path) / case_execution_input["case_id"],
            )
        ),
        "timeout_seconds": DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
        "runtime_context": {},
    }


async def _run_case_review(
    *,
    semaphore: asyncio.Semaphore,
    run_id: str,
    bundle_paths: dict[str, Path],
    cases_artifacts_path: str,
    scan_mode: str,
    test_changes: Any,
    case: dict[str, Any],
) -> dict[str, Any]:
    async with semaphore:
        return await run_repository_case_review_direct(
            _case_review_request(
                run_id=run_id,
                cases_artifacts_path=cases_artifacts_path,
                scan_mode=scan_mode,
                test_changes=test_changes,
                bundle_paths=bundle_paths,
                case=case,
            )
        )


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()

    if not args.run_artifacts_path:
        raise ValueError(
            "Missing run artifacts path. Set "
            f"{ENV_RUN_ARTIFACTS_PATH}=<artifacts/run-id> "
            "or pass --run-artifacts-path."
        )
    if args.start < 1:
        raise ValueError(f"{ENV_START} / --start must be >= 1.")
    if args.limit is not None and args.limit < 1:
        raise ValueError(f"{ENV_LIMIT} / --limit must be >= 1 when set.")

    run_artifacts = Path(args.run_artifacts_path).resolve()
    if not run_artifacts.exists():
        raise FileNotFoundError(f"Run artifacts path does not exist: {run_artifacts}")

    input_path = _resolve_input_path(run_artifacts, args.input_path)
    discovery_path = (
        Path(args.discovery_path).resolve()
        if args.discovery_path
        else run_artifacts / "discovery" / "discovery-result.json"
    )
    triage_path = (
        Path(args.triage_path).resolve()
        if args.triage_path
        else run_artifacts / "triage" / "triage-result.json"
    )

    public_input = read_json(input_path)
    replay_input = materialize_replay_input(
        public_input, workflow="repository-review", artifact_root=run_artifacts
    )
    discovery_result = read_json(discovery_path)
    triage_result = read_json(triage_path)

    # Stage replay starts after runner input preparation. Hydrate only
    # prepared-input runtime roots, not caller materialization.
    replay_input["artifact_paths"] = {
        "discovery": str(run_artifacts / "discovery"),
        "triage": str(run_artifacts / "triage"),
        "cases": str(run_artifacts / "cases"),
    }
    local_root = Path(replay_input["input_bundle_root_path"])
    bundle_paths = read_replay_bundle_paths(local_root)
    test_changes = require_review_intent(replay_input.get("review_intent")).test_changes

    cases = [
        case for case in (triage_result.get("cases") or []) if isinstance(case, dict)
    ]
    if not cases:
        raise RuntimeError("Triage result does not contain cases.")

    start_index = max(0, args.start - 1)
    end_index = (
        len(cases)
        if args.limit is None
        else min(len(cases), start_index + max(0, args.limit))
    )
    selected_cases = cases[start_index:end_index]

    existing_result = _load_existing_result(run_artifacts) or {}
    existing_results = [
        item
        for item in (existing_result.get("case_results") or [])
        if isinstance(item, dict) and _case_result_id(item)
    ]
    results_by_id = {_case_result_id(item): item for item in existing_results}

    to_run = [
        case
        for case in selected_cases
        if args.rerun_existing or _case_id(case) not in results_by_id
    ]

    concurrency = resolve_repository_case_processing_max_concurrency(len(to_run))
    semaphore = asyncio.Semaphore(concurrency)
    tasks = [
        asyncio.create_task(
            _run_case_review(
                semaphore=semaphore,
                run_id=run_artifacts.name,
                cases_artifacts_path=replay_input["artifact_paths"]["cases"],
                scan_mode=replay_input["scan_target"]["scan_mode"],
                test_changes=test_changes,
                bundle_paths=bundle_paths,
                case=case,
            )
        )
        for case in to_run
    ]
    for task in asyncio.as_completed(tasks):
        result = await task
        results_by_id[_case_result_id(result)] = result

    ordered_case_results = [
        results_by_id[_case_id(case)]
        for case in cases
        if _case_id(case) in results_by_id
    ]
    status = "completed" if len(ordered_case_results) == len(cases) else "in-progress"
    workflow_result = build_repository_workflow_result(
        scan_result={
            "discovery_result": discovery_result,
            "triage_result": triage_result,
            # Deletion counts are a reading of the window, not of discovery or triage, so they
            # survive only in the previous result. Rebuilding without them would turn a window
            # whose deletions were skipped into one that claims they were reviewed.
            **_window_deletions(
                existing_result=existing_result,
                replay_input=replay_input,
            ),
        },
        delivery_result=None,
        case_results=ordered_case_results,
    )
    persist_json_artifact(run_artifacts, "repository-review-result", workflow_result)

    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run_artifacts.name,
                "status": status,
                "processed_case_count": len(ordered_case_results),
                "total_case_count": len(cases),
                "selected_start": start_index + 1,
                "selected_end": end_index,
                "selected_case_count": len(selected_cases),
                "ran_case_count": len(to_run),
                "case_processing_concurrency": concurrency,
                "result_path": str(run_artifacts / "repository-review-result.json"),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
