#!/usr/bin/env python3
# Experimental replay script. It may be destructive, may not track the latest
# package contracts, and may not fit current run artifacts. Results are not
# guaranteed; inspect the target artifacts and adjust this script before use.

import argparse
import asyncio
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from scripts.replay.input_bundle import (
    read_json,
    read_replay_bundle_paths,
)
from sec_review_agents.run_artifacts.transcripts import (
    repository_case_thread_name,
    review_thread_dir,
)
from sec_review_agents.runner.temporal_config import DEFAULT_WORKFLOW_TIMEOUT_SECONDS
from sec_review_agents.utils.env import bootstrap_agents_env
from sec_review_agents.workflows.repository.case_execution_input import (
    prepare_case_execution_input,
)
from sec_review_agents.workflows.repository.result import (
    build_scan_summary,
)
from sec_review_agents.workflows.repository.workflow import RepositoryCaseReviewRequest
from sec_review_agents.workflows.repository_case.direct import (
    run_repository_case_review_direct,
)
from sec_review_agents.workflows.review_intent import require_review_intent


def _resolve_run_artifacts(run_root: Path, run_artifacts_path: str | None) -> Path:
    if run_artifacts_path:
        return Path(run_artifacts_path).resolve()

    candidate = run_root / "artifacts" / run_root.name
    if candidate.is_dir():
        return candidate.resolve()

    artifacts_root = run_root / "artifacts"
    matches = (
        sorted(artifacts_root.glob("local-run-*")) if artifacts_root.is_dir() else []
    )
    if len(matches) == 1 and matches[0].is_dir():
        return matches[0].resolve()

    raise FileNotFoundError(
        "Could not resolve run artifacts path. Pass --run-artifacts-path explicitly."
    )


def _result_paths(run_root: Path, run_artifacts: Path) -> list[Path]:
    paths = [
        run_root / "repository-review-result.json",
        run_artifacts / "repository-review-result.json",
    ]
    return [path for i, path in enumerate(paths) if path not in paths[:i]]


def _case_id(item: dict[str, Any]) -> str | None:
    value = item.get("case_id")
    return value if isinstance(value, str) and value else None


def _case_index(case_results: list[dict[str, Any]], case_id: str) -> int:
    for index, item in enumerate(case_results):
        if _case_id(item) == case_id:
            return index
    raise KeyError(f"Case not found in repository result: {case_id}")


def _max_tokens_failure(run_artifacts: Path, case_id: str) -> bool:
    messages_path = (
        run_artifacts
        / "cases"
        / case_id
        / "analyzer"
        / "transcript.json"
    )
    if not messages_path.is_file():
        return False
    try:
        messages = json.loads(messages_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    for message in messages:
        metadata = message.get("response_metadata") or {}
        if metadata.get("stop_reason") == "max_tokens":
            return True
    return False


def _analysis_status(
    run_artifacts: Path, case_id: str
) -> tuple[str | None, str | None]:
    path = run_artifacts / "cases" / case_id / "analyzer" / "analysis-result.json"
    if not path.is_file():
        return None, None
    data = read_json(path)
    error = data.get("overview") if data.get("status") == "unavailable" else None
    return data.get("status"), error


def _prepare_replay_input(
    caller_input: dict[str, Any], run_root: Path, run_artifacts: Path
) -> dict[str, Any]:
    prepared = dict(caller_input)
    # Manual case replay resumes inside the repository workflow. These artifact
    # roots are internal runtime context, not public runner input fields.
    prepared["input_bundle_uri"] = str(run_root)
    prepared["artifact_paths"] = {
        "discovery": str(run_artifacts / "discovery"),
        "triage": str(run_artifacts / "triage"),
        "cases": str(run_artifacts / "cases"),
    }
    return prepared


def _copy_if_exists(source: Path, target: Path) -> None:
    if source.is_dir():
        shutil.copytree(source, target)
    elif source.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def _backup(
    *,
    run_root: Path,
    run_artifacts: Path,
    case_ids: list[str],
) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup_root = run_artifacts / "manual-rerun-backups" / f"manual-case-replay-{stamp}"
    backup_root.mkdir(parents=True, exist_ok=False)

    for path in _result_paths(run_root, run_artifacts):
        _copy_if_exists(path, backup_root / path.relative_to(run_root))
    for case_id in case_ids:
        _copy_if_exists(
            run_artifacts / "cases" / case_id,
            backup_root / "artifacts" / run_artifacts.name / "cases" / case_id,
        )
    return backup_root


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay selected repository-scan cases in an existing materialized run."
    )
    parser.add_argument(
        "--run-root", required=True, help="Path to the local-run-* directory."
    )
    parser.add_argument(
        "--run-artifacts-path",
        default=None,
        help="Optional path to artifacts/local-run-*; defaults to <run-root>/artifacts/<run-id>.",
    )
    parser.add_argument(
        "--case-id",
        action="append",
        required=True,
        help="Case ID to replay. May be provided multiple times.",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=1,
        help="Maximum replayed cases to run in parallel. Defaults to 1.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inspect selected cases without writing or invoking LLMs.",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Do not create a backup before overwriting artifacts.",
    )
    return parser.parse_args()


async def _replay_one_case(
    *,
    semaphore: asyncio.Semaphore,
    replay_input: dict[str, Any],
    run_id: str,
    bundle_paths: dict[str, Path],
    case_index: int,
    case: dict[str, Any],
    repair_mode: Any,
) -> dict[str, Any]:
    async with semaphore:
        cases_artifacts_path = replay_input["artifact_paths"]["cases"]
        case_execution_input = prepare_case_execution_input(
            workspace_snapshot_tar_path=bundle_paths["workspace_snapshot_tar_path"],
            history_path=bundle_paths["history_path"],
            incremental_window_path=bundle_paths.get("incremental_window_path"),
            scan_mode=replay_input["scan_target"]["scan_mode"],
            case=case,
            repair_mode=repair_mode,
        )
        request: RepositoryCaseReviewRequest = {
            "run_id": run_id,
            "case_execution_input": case_execution_input,
            "cases_artifacts_path": cases_artifacts_path,
            "transcript_thread_path": str(
                review_thread_dir(
                    Path(cases_artifacts_path).parent,
                    thread_name=repository_case_thread_name(
                        case_id=case_execution_input["case_id"],
                        index=case_index,
                    ),
                )
            ),
            "timeout_seconds": DEFAULT_WORKFLOW_TIMEOUT_SECONDS,
            "runtime_context": {},
        }
        return await run_repository_case_review_direct(request)


async def _replay_case_outcome(
    *,
    case_id: str,
    semaphore: asyncio.Semaphore,
    replay_input: dict[str, Any],
    run_id: str,
    bundle_paths: dict[str, Path],
    case_index: int,
    case: dict[str, Any],
    repair_mode: Any,
) -> tuple[str, dict[str, Any] | None, str | None]:
    try:
        result = await _replay_one_case(
            semaphore=semaphore,
            replay_input=replay_input,
            run_id=run_id,
            bundle_paths=bundle_paths,
            case_index=case_index,
            case=case,
            repair_mode=repair_mode,
        )
    except Exception as exc:
        return case_id, None, f"{type(exc).__name__}: {exc}"
    return case_id, result, None


def _summary_from_replayed(case_id: str, replayed: dict[str, Any]) -> dict[str, Any]:
    review_record = replayed.get("review_record") or {}
    analysis = review_record.get("analysis") or {}
    mitigation = review_record.get("mitigation") or {}
    verification = review_record.get("verification") or {}
    return {
        "case_id": case_id,
        "title": analysis.get("overview"),
        "disposition": replayed.get("disposition"),
        "reason": replayed.get("reason"),
        "analysis_status": analysis.get("status"),
        "analysis_verdict": analysis.get("verdict"),
        "mitigation_status": mitigation.get("status"),
        "verification_coverage": verification.get("patch_coverage"),
        "changed_files": mitigation.get("changed_files") or [],
    }


def _repository_result_from_replay(
    *,
    result: dict[str, Any],
    case_results: list[dict[str, Any]],
) -> dict[str, Any]:
    scan_summary = result.get("scan_summary")
    return {
        "contract_version": "v4",
        "scan_summary": (
            scan_summary
            if isinstance(scan_summary, dict)
            else build_scan_summary(discovery_result=None, triage_result=None)
        ),
        "deliveries": [
            item for item in (result.get("deliveries") or []) if isinstance(item, dict)
        ],
        "case_results": case_results,
    }


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    run_root = Path(args.run_root).resolve()
    if not run_root.is_dir():
        raise FileNotFoundError(
            f"--run-root does not exist or is not a directory: {run_root}"
        )

    run_artifacts = _resolve_run_artifacts(run_root, args.run_artifacts_path)
    input_path = run_root / "repository-review-input.json"
    triage_path = run_artifacts / "triage" / "triage-result.json"
    result_paths = _result_paths(run_root, run_artifacts)

    if not input_path.is_file():
        raise FileNotFoundError(f"Missing repository input: {input_path}")
    if not result_paths or not result_paths[0].is_file():
        raise FileNotFoundError("Missing repository-review-result.json.")
    if not triage_path.is_file():
        raise FileNotFoundError(f"Missing triage result: {triage_path}")

    replay_input = _prepare_replay_input(read_json(input_path), run_root, run_artifacts)
    repair_mode = require_review_intent(replay_input.get("review_intent")).repair_mode
    bundle_paths = read_replay_bundle_paths(run_root)
    result = read_json(result_paths[0])
    triage_result = read_json(triage_path)
    case_results = result.get("case_results") or []
    if not isinstance(case_results, list) or not case_results:
        raise RuntimeError("Repository result does not contain case_results.")
    triage_cases = [
        case for case in (triage_result.get("cases") or []) if isinstance(case, dict)
    ]

    def find_case_source(case_id: str) -> tuple[int, dict[str, Any]] | None:
        for index, case in enumerate(triage_cases, start=1):
            if _case_id(case) == case_id:
                return index, case
        return None

    case_ids = list(dict.fromkeys(args.case_id))
    dry_run_rows: list[dict[str, Any]] = []
    for case_id in case_ids:
        item = case_results[_case_index(case_results, case_id)]
        case_source = find_case_source(case_id)
        case = case_source[1] if case_source else {}
        analysis_status, analysis_error = _analysis_status(run_artifacts, case_id)
        dry_run_rows.append(
            {
                "case_id": case_id,
                "title": case.get("title"),
                "current_disposition": item.get("disposition"),
                "analysis_status": analysis_status,
                "analysis_error": analysis_error,
                "has_max_tokens_stop": _max_tokens_failure(run_artifacts, case_id),
                "case_artifacts_path": str(run_artifacts / "cases" / case_id),
            }
        )

    if args.dry_run:
        print(
            json.dumps(
                {
                    "ok": True,
                    "dry_run": True,
                    "run_root": str(run_root),
                    "artifact_root": str(run_artifacts),
                    "cases": dry_run_rows,
                    "would_write": [
                        *(str(path) for path in result_paths),
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    backup_path = (
        None
        if args.no_backup
        else _backup(run_root=run_root, run_artifacts=run_artifacts, case_ids=case_ids)
    )
    max_workers = max(1, min(args.jobs, len(case_ids)))

    replay_summary: list[dict[str, Any]] = []
    replayed_by_case_id: dict[str, dict[str, Any]] = {}
    failed_cases: list[dict[str, str]] = []
    semaphore = asyncio.Semaphore(max_workers)
    tasks: list[asyncio.Task[tuple[str, dict[str, Any] | None, str | None]]] = []
    for case_id in case_ids:
        _case_index(case_results, case_id)
        case_source = find_case_source(case_id)
        if not case_source:
            raise KeyError(
                f"Raw case source not found for {case_id}; triage result must contain cases."
            )
        case_index, case = case_source
        print(f":: replay {case_id}: {case.get('title')}", flush=True)
        task = asyncio.create_task(
            _replay_case_outcome(
                case_id=case_id,
                semaphore=semaphore,
                replay_input=replay_input,
                run_id=run_artifacts.name,
                bundle_paths=bundle_paths,
                case_index=case_index,
                case=case,
                repair_mode=repair_mode,
            )
        )
        tasks.append(task)

    for task in asyncio.as_completed(tasks):
        case_id, replayed, error = await task
        if error is None and replayed is not None:
            replayed_by_case_id[case_id] = replayed
            continue
        failed_cases.append({"case_id": case_id, "error": error or "unknown error"})
        print(f":: replay failed {case_id}: {error}", flush=True)

    for case_id in case_ids:
        replayed = replayed_by_case_id.get(case_id)
        if replayed is None:
            continue
        case_results[_case_index(case_results, case_id)] = replayed

        replay_summary.append(_summary_from_replayed(case_id, replayed))

    replayed_result = _repository_result_from_replay(
        result=result,
        case_results=case_results,
    )

    for path in result_paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(replayed_result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print(
        json.dumps(
            {
                "ok": True,
                "dry_run": False,
                "jobs": max_workers,
                "backup_path": str(backup_path) if backup_path else None,
                "summary": replay_summary,
                "failed_cases": failed_cases,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
