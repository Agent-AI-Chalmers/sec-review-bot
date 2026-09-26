# Experimental replay script. It may be destructive, may not track the latest
# package contracts, and may not fit current run artifacts. Results are not
# guaranteed; inspect the target artifacts and adjust this script before use.

import argparse
import asyncio
import json
from pathlib import Path

from sec_review_agents.scan_stages.discovery.stage import (
    build_discovery_result_from_chunks,
    prepare_discovery_chunks,
    scan_discovery_chunk,
)
from sec_review_agents.scan_stages.triage.stage import run_repository_triage_stage
from sec_review_agents.utils.env import bootstrap_agents_env
from sec_review_agents.utils.paths import artifact_path, required_path

from scripts.replay.input_bundle import (
    default_replay_artifact_root,
    read_json,
    restore_replay_workspace,
)


def _default_input_path_from_run_artifacts(run_artifacts_path: Path) -> Path:
    # run_artifacts_path: <workspace-root>/artifacts/run-...
    # input_path:         <workspace-root>/repository-review-input.json
    return run_artifacts_path.parent.parent / "repository-review-input.json"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run repository-review discovery and triage stages using an existing input artifact."
        )
    )
    parser.add_argument(
        "--run-artifacts-path",
        default=None,
        help=(
            "Path to artifacts/run-... directory. If provided, --input-path defaults to "
            "<workspace-root>/repository-review-input.json."
        ),
    )
    parser.add_argument(
        "--input-path",
        default=None,
        help=(
            "Path to repository-review-input.json. "
            "Defaults to <workspace-root>/repository-review-input.json when "
            "--run-artifacts-path is provided."
        ),
    )
    parser.add_argument(
        "--triage-mode",
        choices=["single", "batched"],
        default="single",
        help="Triage execution mode. Defaults to single.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=30,
        help="Maximum candidate count per batch when --triage-mode=batched.",
    )
    return parser.parse_args()


def _resolve_input_path(args: argparse.Namespace) -> tuple[Path, Path | None]:
    run_artifacts_path = (
        Path(args.run_artifacts_path).resolve() if args.run_artifacts_path else None
    )
    if run_artifacts_path is not None and not run_artifacts_path.exists():
        raise FileNotFoundError(
            f"Run artifacts path does not exist: {run_artifacts_path}"
        )

    if args.input_path:
        input_path = Path(args.input_path).resolve()
    elif run_artifacts_path is not None:
        input_path = _default_input_path_from_run_artifacts(run_artifacts_path)
    else:
        raise ValueError("Missing --input-path (or provide --run-artifacts-path).")

    if not input_path.exists():
        raise FileNotFoundError(f"Input JSON does not exist: {input_path}")
    return input_path, run_artifacts_path


def _run_artifacts_path(replay_input: dict, run_artifacts_path: Path | None) -> Path:
    if run_artifacts_path is not None:
        return run_artifacts_path
    return default_replay_artifact_root(
        input_bundle_root=required_path(
            replay_input.get("input_bundle_uri"),
            label="input_bundle_uri",
        ),
        run_id=str(replay_input.get("run_id") or ""),
    )


def _hydrate_artifact_paths(replay_input: dict, run_artifacts_path: Path) -> None:
    # This script replays repository stages from an existing artifact directory.
    # Hydrate only prepared-input runtime roots, not caller input.
    replay_input["artifact_paths"] = {
        "discovery": str(run_artifacts_path / "discovery"),
        "triage": str(run_artifacts_path / "triage"),
        "cases": str(run_artifacts_path / "cases"),
    }


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    input_path, requested_run_artifacts_path = _resolve_input_path(args)
    replay_input = read_json(input_path)
    run_artifacts_path = _run_artifacts_path(replay_input, requested_run_artifacts_path)
    _hydrate_artifact_paths(replay_input, run_artifacts_path)

    scan_target = replay_input["scan_target"]
    local_root = required_path(
        replay_input.get("input_bundle_uri"),
        label="input_bundle_uri",
    )
    workspace_root = restore_replay_workspace(
        input_bundle_root=local_root,
        artifact_root=run_artifacts_path,
    )
    manifest = prepare_discovery_chunks(
        workspace_root=workspace_root,
        scan_mode=str(scan_target["scan_mode"]),
        scan_scope=replay_input["scan_scope"],
        discovery_artifacts_path=artifact_path(
            replay_input["artifact_paths"], "discovery"
        ),
    )
    chunk_results = [
        await scan_discovery_chunk(chunk=chunk, root=workspace_root)
        for chunk in manifest["chunks"]
    ]
    discovery_result = build_discovery_result_from_chunks(
        entries=list(manifest["entries"]),
        skipped_files=list(manifest["skipped_files"]),
        chunks=list(manifest["chunks"]),
        chunk_results=chunk_results,
        scan_mode=str(manifest["scan_mode"]),
        chunk_target_tokens=int(manifest["chunk_target_tokens"]),
        discovery_artifacts_path=manifest["discovery_artifacts_path"],
    )

    triage_result = await run_repository_triage_stage(
        triage_root=artifact_path(replay_input["artifact_paths"], "triage"),
        discovery_result=discovery_result,
        triage_mode=args.triage_mode,
        max_batch_size=args.batch_size,
    )

    discovery_artifacts_path = Path(
        artifact_path(replay_input["artifact_paths"], "discovery")
    ).resolve()
    triage_artifacts_path = Path(
        artifact_path(replay_input["artifact_paths"], "triage")
    ).resolve()
    discovery_counts = discovery_result.get("counts") or {}
    triage_counts = triage_result.get("counts") or {}

    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run_artifacts_path.name,
                "discovery_status": discovery_result.get("status"),
                "candidate_count": discovery_counts.get("candidate_count"),
                "triage_status": triage_result.get("status"),
                "triage_mode": args.triage_mode,
                "batch_size": (
                    args.batch_size if args.triage_mode == "batched" else None
                ),
                "input_candidate_count": triage_counts.get("input_candidate_count"),
                "case_count": triage_counts.get("case_count"),
                "suppressed_candidate_count": triage_counts.get(
                    "suppressed_candidate_count"
                ),
                "discovery_result_path": str(
                    discovery_artifacts_path / "discovery-result.json"
                ),
                "triage_result_path": str(triage_artifacts_path / "triage-result.json"),
                "triage_input_path": str(triage_artifacts_path / "triage-input.json"),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
