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
from sec_review_agents.utils.env import bootstrap_agents_env
from sec_review_agents.utils.paths import artifact_path

from scripts.replay.input_bundle import (
    default_replay_artifact_root,
    materialize_replay_input,
    read_json,
    restore_replay_workspace,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run repository-review discovery stage only using an existing input artifact."
    )
    parser.add_argument(
        "--input-path",
        required=True,
        help="Path to repository-review-input.json.",
    )
    return parser.parse_args()


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    input_path = Path(args.input_path).resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"Input JSON does not exist: {input_path}")

    public_input = read_json(input_path)
    run_artifacts = input_path.parent / "artifacts" / "replay-discovery"
    replay_input = materialize_replay_input(
        public_input, workflow="repository-review", artifact_root=run_artifacts
    )
    run_id = (
        Path(artifact_path(replay_input["artifact_paths"], "discovery"))
        .resolve()
        .parent.name
    )

    scan_target = replay_input["scan_target"]
    local_root = Path(replay_input["input_bundle_root_path"])
    workspace_root = restore_replay_workspace(
        input_bundle_root=local_root,
        artifact_root=default_replay_artifact_root(
            input_bundle_root=local_root,
            run_id=str(replay_input.get("run_id") or ""),
        ),
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
        deployment_input_limit_tokens=int(manifest["deployment_input_limit_tokens"]),
        chunk_target_tokens=int(manifest["chunk_target_tokens"]),
        chunk_target_ratio=str(manifest["chunk_target_ratio"]),
        chunk_hard_limit_tokens=int(manifest["chunk_hard_limit_tokens"]),
        chunk_strategy=str(manifest["chunk_strategy"]),
        discovery_artifacts_path=manifest["discovery_artifacts_path"],
    )

    discovery_artifacts_path = Path(
        artifact_path(replay_input["artifact_paths"], "discovery")
    ).resolve()
    discovery_result_path = discovery_artifacts_path / "discovery-result.json"
    discovery_counts = discovery_result.get("counts") or {}

    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run_id,
                "discovery_status": discovery_result.get("status"),
                "scannable_file_count": discovery_counts.get("scannable_file_count"),
                "candidate_count": discovery_counts.get("candidate_count"),
                "discovery_result_path": str(discovery_result_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
