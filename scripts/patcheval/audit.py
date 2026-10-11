"""Audit materialized PatchEval workspaces for one tag.

Read-only survey of the `.agent-workspace-patcheval-*` trees: for every CVE and experiment
variant it reports whether the workspace, its symlink, the run's exit code, and the
generated patch are present. It reads only JSON and the filesystem, so it needs neither
jq nor a configured agents environment.

Status meanings:

    ok             exit-code.txt is 0 and workspace.patch exists and is non-empty
    empty-patch    exit-code.txt is 0 and workspace.patch exists but is empty
    exit-N         exit-code.txt exists and is non-zero
    missing-*      expected artifact/link/target is missing
    blocked-*      workspace path exists but is not the expected directory/symlink
"""

import argparse
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from scripts.patcheval.experiments import EXECUTED_EXPERIMENTS
from scripts.patcheval.workspace_state import (
    dataset_cves,
    experiment_state,
    observed_cves,
    workspace_dir,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TAG = "DEEPSEEK-V4-PRO"
DEFAULT_DATASET = (
    REPO_ROOT
    / "PatchEval"
    / "patcheval"
    / "datasets"
    / "patcheval_runtime_subset_cleaned.json"
)

HEADER = ("cve", "experiment", "status", "exit_code", "patch_bytes", "run_dir")

# The audit reports a finished patch as "ok"; the shared state calls it "complete".
_AUDIT_STATUS = {"complete": "ok"}
_SYMLINK_STATUSES = {"missing-symlink", "blocked-non-symlink", "missing-target"}


@dataclass(frozen=True)
class AuditRow:
    cve: str
    experiment: str
    status: str
    exit_code: str
    patch_bytes: str
    run_dir: str

    def columns(self) -> tuple[str, ...]:
        return (
            self.cve,
            self.experiment,
            self.status,
            self.exit_code,
            self.patch_bytes,
            self.run_dir,
        )


def _audit_row(*, root: Path, tag: str, cve: str, experiment: str) -> AuditRow:
    state = experiment_state(root=root, tag=tag, cve=cve, experiment=experiment)
    workspace = workspace_dir(root=root, tag=tag, cve=cve)

    if state.status == "missing-workspace":
        reported_path = ""
    elif state.status == "blocked-workspace":
        reported_path = str(workspace)
    elif state.status in _SYMLINK_STATUSES:
        reported_path = str(workspace / f"{cve}-{experiment}")
    else:
        reported_path = str(state.run_dir) if state.run_dir is not None else ""

    return AuditRow(
        cve=cve,
        experiment=experiment,
        status=_AUDIT_STATUS.get(state.status, state.status),
        exit_code=state.exit_code or "",
        patch_bytes="" if state.patch_bytes is None else str(state.patch_bytes),
        run_dir=reported_path,
    )


def _visible_rows(rows: Sequence[AuditRow], args: argparse.Namespace) -> list[AuditRow]:
    if args.print_all:
        return list(rows)
    if args.only_bad:
        return [row for row in rows if row.status not in {"ok", "empty-patch"}]
    return [row for row in rows if row.status != "ok"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Audit PatchEval agent workspaces for a tag and report per-experiment "
            "artifact status."
        )
    )
    parser.add_argument("--tag", default=DEFAULT_TAG, help="Workspace tag.")
    parser.add_argument(
        "--dataset",
        default=str(DEFAULT_DATASET),
        help=(
            "PatchEval enriched dataset JSON. If present, audit all CVEs in it, "
            "including missing workspace directories."
        ),
    )
    parser.add_argument(
        "--existing-only",
        action="store_true",
        help="Audit only CVEs whose workspace directory already exists.",
    )
    parser.add_argument(
        "--all", dest="print_all", action="store_true", help="Print ok experiments too."
    )
    parser.add_argument(
        "--only-bad",
        action="store_true",
        help="Print only non-ok and non-empty-patch experiments.",
    )
    parser.add_argument(
        "--summary-only", action="store_true", help="Print only summary counts."
    )
    parser.add_argument(
        "--no-header", action="store_true", help="Do not print the TSV header."
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    tag = args.tag.replace("/", "-")
    dataset = Path(args.dataset)
    if not dataset.is_absolute():
        dataset = REPO_ROOT / dataset

    try:
        cves = (
            dataset_cves(dataset)
            if dataset.is_file()
            else observed_cves(root=REPO_ROOT, tag=tag)
        )
    except ValueError:
        print("No CVEs found to audit.", file=sys.stderr)
        return 2

    rows: list[AuditRow] = []
    for cve in cves:
        if args.existing_only:
            workspace = workspace_dir(root=REPO_ROOT, tag=tag, cve=cve)
            if not workspace.is_dir():
                continue
        rows.extend(
            _audit_row(root=REPO_ROOT, tag=tag, cve=cve, experiment=experiment)
            for experiment in EXECUTED_EXPERIMENTS
        )

    if not args.summary_only:
        if not args.no_header:
            print("\t".join(HEADER))
        for row in _visible_rows(rows, args):
            print("\t".join(row.columns()))

    summary = [
        f"  {status}: {count}"
        for status, count in Counter(row.status for row in rows).items()
    ]
    summary.append(f"  total: {len(rows)}")
    print()
    print("Summary:")
    for line in sorted(summary):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
