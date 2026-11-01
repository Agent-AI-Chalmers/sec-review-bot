"""Inspect materialized PatchEval experiment workspaces on disk.

The audit, collect, and pool drivers all need to answer the same questions about an
experiment: does the workspace and its symlink exist, what exit code did the run record,
and where is the generated patch. This module is the single implementation; each driver
maps the canonical status onto the vocabulary its own output uses.

Everything here is standard library, so a read-only driver can use it without a
configured agents environment.
"""

import argparse
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from scripts.patcheval.experiments import EXECUTED_EXPERIMENTS

WORKSPACE_DIR_PREFIX = ".agent-workspace-patcheval-"
WORKSPACE_DIR_RE = re.compile(rf"^{re.escape(WORKSPACE_DIR_PREFIX)}(CVE-\d+-\d+)-(.+)$")


@dataclass(frozen=True)
class ExperimentState:
    """What the filesystem says about one materialized experiment.

    `status` is the canonical vocabulary: `missing-workspace`, `blocked-workspace`,
    `missing-symlink`, `blocked-non-symlink`, `missing-target`, `missing-exit-code`,
    `exit-<code>`, `missing-patch`, `empty-patch`, or `complete`.
    """

    status: str
    exit_code: str | None = None
    run_id: str | None = None
    run_dir: Path | None = None
    patch_path: Path | None = None
    patch_bytes: int | None = None


def workspace_dir(*, root: Path, tag: str, cve: str) -> Path:
    return root / f"{WORKSPACE_DIR_PREFIX}{cve}-{tag}"


def observed_cves(*, root: Path, tag: str) -> list[str]:
    """CVEs with a workspace path for this tag, sorted by CVE id.

    A path that exists but is not a directory is included: that blocked workspace is
    exactly what the audit and collect drivers report.
    """
    cves: set[str] = set()
    for entry in sorted(root.glob(f"{WORKSPACE_DIR_PREFIX}CVE-*-{tag}")):
        match = WORKSPACE_DIR_RE.match(entry.name)
        if match:
            cves.add(match.group(1))
    if not cves:
        raise ValueError(
            f"No observed PatchEval workspaces found for tag {tag!r} under {root}"
        )
    return sorted(cves)


def read_dataset(dataset_path: Path) -> list[dict]:
    """Reject ambiguous task identity before queueing or filling denominators."""
    data = json.loads(dataset_path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        raise ValueError(
            f"PatchEval dataset must be a nonempty JSON list: {dataset_path}"
        )
    seen: set[str] = set()
    for row, item in enumerate(data, 1):
        cve = item.get("cve_id") if isinstance(item, dict) else None
        if not isinstance(cve, str) or not re.fullmatch(r"CVE-\d{4}-\d+", cve):
            raise ValueError(f"Invalid cve_id at row {row} in {dataset_path}")
        if cve in seen:
            raise ValueError(f"Duplicate {cve} at row {row} in {dataset_path}")
        seen.add(cve)
    return data


def dataset_cves(dataset_path: Path) -> list[str]:
    return [item["cve_id"] for item in read_dataset(dataset_path)]


def first_workspace_patch(experiment_dir: Path) -> Path | None:
    """Read only the stage-owned final patch, never an arbitrary recursive match."""
    run = experiment_dir.resolve()
    # Local materialization already scopes artifacts to this run directory.
    root = run / "artifacts"
    patches = [
        root / stage / "workspace.patch" for stage in ("mitigator", "single-agent")
    ]
    present = [path for path in patches if path.is_file()]
    if len(present) > 1:
        raise ValueError(f"Ambiguous patch owners in {run}")
    return present[0] if present else None


def experiment_state(
    *,
    root: Path,
    tag: str,
    cve: str,
    experiment: str,
) -> ExperimentState:
    workspace = workspace_dir(root=root, tag=tag, cve=cve)
    experiment_dir = workspace / f"{cve}-{experiment}"

    if not workspace.exists():
        return ExperimentState("missing-workspace")
    if not workspace.is_dir():
        return ExperimentState("blocked-workspace")
    log_prefix = workspace / "_logs" / f"{cve}-{experiment}"
    pending = log_prefix.with_name(log_prefix.name + ".pending")
    # A retry owns the current result immediately, even before materialization.
    # Its historical symlink must not make a running/failed retry look successful.
    if pending.exists() or (
        not experiment_dir.exists() and not experiment_dir.is_symlink()
    ):
        # A run can fail or be interrupted before the driver publishes its link.
        # Such attempts must not be silently requeued as never-started work.
        failure_path = log_prefix.with_name(log_prefix.name + ".exit-code")
        if failure_path.is_file():
            code = failure_path.read_text(encoding="utf-8").strip()
            return ExperimentState(f"exit-{code or 'unknown'}", exit_code=code)
        if any(log_prefix.parent.glob(log_prefix.name + ".*")):
            return ExperimentState("missing-exit-code")
        return ExperimentState("missing-symlink")
    if not experiment_dir.is_symlink():
        return ExperimentState("blocked-non-symlink")

    try:
        run_dir = experiment_dir.resolve(strict=True)
    except OSError:
        return ExperimentState("missing-target")
    if not run_dir.is_dir():
        return ExperimentState("missing-target")

    exit_code_path = run_dir / "exit-code.txt"
    if not exit_code_path.is_file():
        return ExperimentState(
            "missing-exit-code", run_id=run_dir.name, run_dir=run_dir
        )
    exit_code = exit_code_path.read_text(encoding="utf-8", errors="replace").strip()
    if exit_code != "0":
        return ExperimentState(
            f"exit-{exit_code or 'unknown'}",
            exit_code=exit_code,
            run_id=run_dir.name,
            run_dir=run_dir,
        )

    patch_path = first_workspace_patch(run_dir)
    if patch_path is None:
        return ExperimentState(
            "missing-patch",
            exit_code=exit_code,
            run_id=run_dir.name,
            run_dir=run_dir,
        )

    patch_bytes = patch_path.stat().st_size
    return ExperimentState(
        "empty-patch" if patch_bytes == 0 else "complete",
        exit_code=exit_code,
        run_id=run_dir.name,
        run_dir=run_dir,
        patch_path=patch_path,
        patch_bytes=patch_bytes,
    )


def _status_lines(root: Path, tag: str, cves: list[str]) -> Iterator[str]:
    for cve in cves:
        for experiment in EXECUTED_EXPERIMENTS:
            state = experiment_state(root=root, tag=tag, cve=cve, experiment=experiment)
            yield f"{cve}\t{experiment}\t{state.status}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print the status of materialized PatchEval experiments."
    )
    parser.add_argument(
        "--root", required=True, help="Repository root holding the workspaces."
    )
    parser.add_argument("--tag", required=True, help="Workspace tag suffix.")
    parser.add_argument("--dataset", help="PatchEval dataset JSON enumerating CVEs.")
    parser.add_argument(
        "--cve",
        action="append",
        default=[],
        help="Print the status of this CVE. Repeatable; overrides --dataset.",
    )
    args = parser.parse_args()
    if not args.cve and not args.dataset:
        parser.error("provide --dataset or at least one --cve")
    return args


def main() -> None:
    args = parse_args()
    root = Path(args.root).resolve()
    cves = args.cve if args.cve else dataset_cves(Path(args.dataset).resolve())
    for line in _status_lines(root, args.tag, cves):
        print(line)


if __name__ == "__main__":
    main()
