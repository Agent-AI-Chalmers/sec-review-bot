"""Build a local Memory tree from observations, without deployed services."""

import argparse
import asyncio
import hashlib
import json
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path

from sec_review_agents.memory.maintainer import maintain_memory_tree
from sec_review_agents.runtime.trajectories import trajectory_path
from sec_review_agents.utils.env import bootstrap_agents_env


def _fingerprint(path: Path) -> dict[str, str]:
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def _tree_fingerprint(root: Path) -> list[dict[str, str]]:
    return [
        {**_fingerprint(path), "path": path.relative_to(root).as_posix()}
        for path in sorted(root.rglob("*"))
        if path.is_file()
    ]


async def run(args: argparse.Namespace) -> Path:
    inputs = [path.expanduser().resolve() for path in args.inputs]
    if not inputs:
        raise ValueError("At least one observation is required.")
    ids = [path.stem for path in inputs]
    if len(set(inputs)) != len(inputs) or len(set(ids)) != len(ids):
        raise ValueError("Observation paths and filename stems must be unique.")
    for path in inputs:
        if not path.is_file() or path.suffix != ".md":
            raise ValueError(f"Observation must be a Markdown file: {path}")
    base = args.base_memory.expanduser().resolve() if args.base_memory else None
    output = args.output_dir.expanduser().resolve()
    if base is not None:
        if not (base / "MEMORY.md").is_file():
            raise ValueError(f"Base memory index is missing: {base}")
        if (base / "observations").exists():
            raise ValueError(
                "Base memory must not contain a staging observations directory."
            )
        if output.is_relative_to(base):
            raise ValueError("Output directory must be outside the base memory tree.")
    manifest = {
        "status": "running",
        "started_at": datetime.now(UTC).isoformat(),
        "deployment_override": args.deployment,
        "observations": [
            {"id": identifier, **_fingerprint(path)}
            for identifier, path in zip(ids, inputs, strict=True)
        ],
        "base_memory": (
            {"path": str(base), "files": _tree_fingerprint(base)} if base else None
        ),
    }
    output.mkdir(parents=True, exist_ok=False)
    manifest_path = output / "manifest.json"

    def save_manifest() -> None:
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    save_manifest()
    try:
        await maintain_memory_tree(
            base_memory_tree=base,
            observations=list(zip(ids, inputs, strict=True)),
            worktree_root=output / "memory",
            maintainer_trajectory_path=trajectory_path(output, name="maintainer"),
            deployment=args.deployment,
        )
        # Observations are maintainer input, not part of the published Memory tree.
        shutil.rmtree(output / "memory" / "observations")
        if not (output / "memory" / "MEMORY.md").is_file():
            raise ValueError("Maintainer output is missing MEMORY.md.")
        manifest["memory_files"] = _tree_fingerprint(output / "memory")
        manifest["status"] = "completed"
    finally:
        # Keep partial worktrees and trajectories on failure, including cancellation.
        if manifest["status"] == "running":
            manifest["status"] = "failed"
        manifest["finished_at"] = datetime.now(UTC).isoformat()
        save_manifest()
    return output / "memory"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "inputs",
        nargs="+",
        type=Path,
        help="Observation Markdown files in processing order.",
    )
    parser.add_argument(
        "--base-memory",
        type=Path,
        help="Existing Memory tree; omitted for an empty initial tree.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="New output directory; must not exist.",
    )
    parser.add_argument(
        "--deployment", help="Optional maintainer model deployment override."
    )
    args = parser.parse_args(argv)
    bootstrap_agents_env()
    try:
        memory = asyncio.run(run(args))
    except Exception as error:  # noqa: BLE001
        print(str(error), file=sys.stderr)
        return 1
    print(f"Memory: {memory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
