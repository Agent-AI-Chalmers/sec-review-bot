# Experimental replay script. It may be destructive, may not track the latest
# package contracts, and may not fit current run artifacts. Results are not
# guaranteed; inspect the target artifacts and adjust this script before use.

import argparse
import asyncio
import json
from pathlib import Path

from sec_review_agents.scan_stages.discovery.stage import (
    build_discovery_result_from_chunks,
    persist_discovery_result,
    prepare_discovery_chunks,
    scan_discovery_chunk,
)
from sec_review_agents.utils.env import bootstrap_agents_env
from sec_review_agents.workflows.prepared_input import PreparedRepositoryInput

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


def _run_id_from_replay_input(replay_input: PreparedRepositoryInput) -> str:
    return Path(replay_input.discovery_artifacts_path).resolve().parent.name


async def main() -> None:
    bootstrap_agents_env()
    args = _parse_args()
    input_path = Path(args.input_path).resolve()

    if not input_path.exists():
        raise FileNotFoundError(f"Input JSON does not exist: {input_path}")

    public_input = read_json(input_path)
    run_artifacts = input_path.parent / "artifacts" / "replay-discovery"
    replay_input = materialize_replay_input(public_input, artifact_root=run_artifacts)
    run_id = _run_id_from_replay_input(replay_input)

    local_root = Path(replay_input.input_bundle_root_path)
    workspace_root = restore_replay_workspace(
        input_bundle_root=local_root,
        artifact_root=default_replay_artifact_root(
            input_bundle_root=local_root,
            run_id=run_id,
        ),
    )
    manifest = prepare_discovery_chunks(
        workspace_root=workspace_root,
        scan_mode=replay_input.scan_mode,
        scan_scope=replay_input.scan_scope,
        discovery_artifacts_path=Path(replay_input.discovery_artifacts_path),
    )
    chunk_results = [
        await scan_discovery_chunk(chunk=chunk, root=workspace_root)
        for chunk in manifest.chunks
    ]
    discovery_result = build_discovery_result_from_chunks(
        entries=manifest.entries,
        skipped_files=manifest.skipped_files,
        chunks=manifest.chunks,
        chunk_results=chunk_results,
        scan_mode=manifest.scan_mode,
        deployment_input_limit_tokens=manifest.deployment_input_limit_tokens,
        chunk_target_tokens=manifest.chunk_target_tokens,
        chunk_target_ratio=manifest.chunk_target_ratio,
        chunk_hard_limit_tokens=manifest.chunk_hard_limit_tokens,
        discovery_concurrency=manifest.max_concurrency,
        chunk_strategy=manifest.chunk_strategy,
    )
    persist_discovery_result(
        discovery_artifacts_path=Path(manifest.discovery_artifacts_path),
        result=discovery_result,
    )

    discovery_artifacts_path = Path(replay_input.discovery_artifacts_path).resolve()
    discovery_result_path = discovery_artifacts_path / "discovery-result.json"
    discovery_counts = discovery_result.counts

    print(
        json.dumps(
            {
                "ok": True,
                "run_id": run_id,
                "discovery_status": discovery_result.status,
                "scannable_file_count": discovery_counts.scannable_file_count,
                "candidate_count": discovery_counts.candidate_count,
                "discovery_result_path": str(discovery_result_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
