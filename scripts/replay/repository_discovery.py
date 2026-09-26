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
from sec_review_agents.utils.paths import artifact_path, required_path

from scripts.replay.input_bundle import (
    default_replay_artifact_root,
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


def _hydrate_artifact_paths(replay_input: dict) -> None:
    local_root_path = replay_input.get("input_bundle_uri")
    if not isinstance(local_root_path, str) or not local_root_path.strip():
        return

    # Stage replay starts after runner input preparation. Hydrate only
    # prepared-input runtime roots, not caller input.
    run_artifacts = default_replay_artifact_root(
        input_bundle_root=Path(local_root_path),
        run_id=str(replay_input.get("run_id") or ""),
    )
    replay_input["artifact_paths"] = {
        "discovery": str(run_artifacts / "discovery"),
    }


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    input_path = Path(args.input_path).resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"Input JSON does not exist: {input_path}")

    replay_input = read_json(input_path)
    _hydrate_artifact_paths(replay_input)
    run_id = (
        Path(artifact_path(replay_input["artifact_paths"], "discovery"))
        .resolve()
        .parent.name
    )

    scan_target = replay_input["scan_target"]
    local_root = required_path(
        replay_input.get("input_bundle_uri"),
        label="input_bundle_uri",
    )
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
        chunk_target_tokens=int(manifest["chunk_target_tokens"]),
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
