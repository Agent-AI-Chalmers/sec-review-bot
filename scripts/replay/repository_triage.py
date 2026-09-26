# Experimental replay script. It may be destructive, may not track the latest
# package contracts, and may not fit current run artifacts. Results are not
# guaranteed; inspect the target artifacts and adjust this script before use.

import argparse
import asyncio
import json
from pathlib import Path

from sec_review_agents.scan_stages.triage.stage import run_repository_triage_stage
from sec_review_agents.utils.env import bootstrap_agents_env
from sec_review_agents.utils.paths import artifact_path, required_path

from scripts.replay.input_bundle import default_replay_artifact_root, read_json


def _default_input_path_from_run_artifacts(run_artifacts_path: Path) -> Path:
    # run_artifacts_path: <workspace-root>/artifacts/run-...
    # input_path:         <workspace-root>/repository-review-input.json
    return run_artifacts_path.parent.parent / "repository-review-input.json"


def _default_discovery_path_from_run_artifacts(run_artifacts_path: Path) -> Path:
    return run_artifacts_path / "discovery" / "discovery-result.json"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run repository-review triage stage only using an existing input/discovery artifact pair."
        )
    )
    parser.add_argument(
        "--run-artifacts-path",
        default=None,
        help=(
            "Path to artifacts/run-... directory. If provided, defaults are inferred for "
            "--input-path and --discovery-path."
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
        "--discovery-path",
        default=None,
        help=(
            "Path to discovery-result.json. "
            "Defaults to <run-artifacts-path>/discovery/discovery-result.json when "
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


def _resolve_paths(args: argparse.Namespace) -> tuple[Path, Path, Path | None]:
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

    if args.discovery_path:
        discovery_path = Path(args.discovery_path).resolve()
    elif run_artifacts_path is not None:
        discovery_path = _default_discovery_path_from_run_artifacts(run_artifacts_path)
    else:
        raise ValueError("Missing --discovery-path (or provide --run-artifacts-path).")

    if not input_path.exists():
        raise FileNotFoundError(f"Input JSON does not exist: {input_path}")
    if not discovery_path.exists():
        raise FileNotFoundError(f"Discovery JSON does not exist: {discovery_path}")
    return input_path, discovery_path, run_artifacts_path


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
    # Stage replay starts after runner input preparation. Hydrate only
    # prepared-input runtime roots, not caller input.
    replay_input["artifact_paths"] = {
        "discovery": str(run_artifacts_path / "discovery"),
        "triage": str(run_artifacts_path / "triage"),
        "cases": str(run_artifacts_path / "cases"),
    }


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    input_path, discovery_path, requested_run_artifacts_path = _resolve_paths(args)

    replay_input = read_json(input_path)
    discovery_result = read_json(discovery_path)
    run_artifacts_path = _run_artifacts_path(replay_input, requested_run_artifacts_path)
    _hydrate_artifact_paths(replay_input, run_artifacts_path)

    triage_result = await run_repository_triage_stage(
        triage_root=artifact_path(replay_input["artifact_paths"], "triage"),
        discovery_result=discovery_result,
        triage_mode=args.triage_mode,
        max_batch_size=args.batch_size,
    )

    triage_artifacts_path = Path(
        artifact_path(replay_input["artifact_paths"], "triage")
    ).resolve()
    triage_result_path = triage_artifacts_path / "triage-result.json"
    triage_counts = triage_result.get("counts") or {}

    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run_artifacts_path.name,
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
                "triage_result_path": str(triage_result_path),
                "triage_input_path": str(triage_artifacts_path / "triage-input.json"),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
