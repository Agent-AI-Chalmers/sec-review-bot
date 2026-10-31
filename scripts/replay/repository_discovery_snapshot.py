"""Run discovery only against a path extracted from a historical git commit.

This is an experiment/replay helper, not a production workflow entrypoint. It
uses the current discovery implementation and model configuration while taking
the scanned source tree from the requested git commit.
"""

import argparse
import asyncio
import io
import json
import subprocess
import tarfile
import tempfile
from fractions import Fraction
from pathlib import Path

from sec_review_agents.scan_stages.discovery.input import DiscoveryChunk
from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryChunkResult,
    DiscoveryResult,
)
from sec_review_agents.scan_stages.discovery.stage import (
    build_discovery_result_from_chunks,
    persist_discovery_result,
    prepare_discovery_chunks,
    scan_discovery_chunk,
)
from sec_review_agents.utils.env import bootstrap_agents_env


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run repository discovery only on a historical git path."
    )
    parser.add_argument(
        "--repository",
        type=Path,
        required=True,
        help="Git repository containing the historical commit.",
    )
    parser.add_argument(
        "--commit",
        required=True,
        help="Commit or revision expression to extract (for example COMMIT^).",
    )
    parser.add_argument(
        "--path",
        required=True,
        help="Repository-relative path to extract and scan.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Directory for the extracted workspace and discovery artifacts.",
    )
    parser.add_argument(
        "--chunk-target-ratio",
        type=Fraction,
        default=Fraction(1, 5),
        help="Fraction of the deployment input limit used by batched chunks (default: 1/5).",
    )
    parser.add_argument(
        "--chunk-strategy",
        choices=("single-file", "batched"),
        help=(
            "Discovery chunking mode. Defaults to the worker setting "
            "AGENT_DISCOVERY_CHUNK_STRATEGY."
        ),
    )
    parser.add_argument(
        "--paths-ignore",
        action="append",
        default=[],
        help="Repository-relative discovery ignore pattern; may be repeated.",
    )
    return parser.parse_args()


def _extract_path(*, repository: Path, commit: str, path: str, workspace: Path) -> None:
    archive = subprocess.run(
        ["git", "archive", "--format=tar", commit, "--", path],
        cwd=repository,
        check=True,
        capture_output=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        tar.extractall(workspace, filter="data")


async def _run_discovery(
    *,
    workspace: Path,
    artifacts: Path,
    chunk_target_ratio: Fraction,
    chunk_strategy: str | None,
    paths_ignore: list[str],
) -> DiscoveryResult:
    manifest = prepare_discovery_chunks(
        workspace_root=workspace,
        scan_mode="full",
        scan_scope={"paths_ignore": paths_ignore},
        discovery_artifacts_path=artifacts,
        chunk_target_ratio=(
            chunk_target_ratio.numerator,
            chunk_target_ratio.denominator,
        ),
        chunk_strategy=chunk_strategy,
    )
    chunks = manifest.chunks
    semaphore = asyncio.Semaphore(max(1, manifest.max_concurrency))

    async def scan(
        index: int, chunk: DiscoveryChunk
    ) -> tuple[int, DiscoveryChunkResult]:
        async with semaphore:
            result = await scan_discovery_chunk(
                chunk=chunk,
                root=workspace,
                discovery_artifacts_path=artifacts,
            )
            return index, result

    ordered_results: list[DiscoveryChunkResult | None] = [None] * len(chunks)
    for index, result in await asyncio.gather(
        *(scan(index, chunk) for index, chunk in enumerate(chunks))
    ):
        ordered_results[index] = result

    result = build_discovery_result_from_chunks(
        entries=manifest.entries,
        skipped_files=manifest.skipped_files,
        chunks=chunks,
        chunk_results=[item for item in ordered_results if item is not None],
        scan_mode="full",
        deployment_input_limit_tokens=manifest.deployment_input_limit_tokens,
        chunk_target_tokens=manifest.chunk_target_tokens,
        chunk_target_ratio=manifest.chunk_target_ratio,
        chunk_hard_limit_tokens=manifest.chunk_hard_limit_tokens,
        discovery_concurrency=manifest.max_concurrency,
        chunk_strategy=manifest.chunk_strategy,
    )
    persist_discovery_result(discovery_artifacts_path=artifacts, result=result)
    return result


async def _main() -> None:
    args = _parse_args()
    repository = args.repository.resolve()
    if not repository.is_dir():
        raise SystemExit(f"--repository is not a directory: {repository}")
    if not 0 < args.chunk_target_ratio < 1:
        raise SystemExit("--chunk-target-ratio must be between 0 and 1.")

    bootstrap_agents_env()
    output_dir = (
        args.output_dir.resolve()
        if args.output_dir
        else Path(tempfile.mkdtemp(prefix="repository-discovery-snapshot-"))
    )
    workspace = output_dir / "workspace"
    artifacts = output_dir / "artifacts" / "discovery"
    workspace.mkdir(parents=True, exist_ok=True)
    artifacts.mkdir(parents=True, exist_ok=True)
    _extract_path(
        repository=repository,
        commit=args.commit,
        path=args.path,
        workspace=workspace,
    )
    result = await _run_discovery(
        workspace=workspace,
        artifacts=artifacts,
        chunk_target_ratio=args.chunk_target_ratio,
        chunk_strategy=args.chunk_strategy,
        paths_ignore=args.paths_ignore,
    )
    result_path = output_dir / "discovery-result.json"
    persist_discovery_result(discovery_artifacts_path=output_dir, result=result)
    print(
        json.dumps(
            {
                "output_dir": str(output_dir),
                "result_path": str(result_path),
                "counts": result.counts.model_dump(),
                "metadata": result.metadata.model_dump(),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(_main())
