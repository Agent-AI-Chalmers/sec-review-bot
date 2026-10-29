#!/usr/bin/env python3
import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from scripts.patcheval.experiments import (
    EVALUATION_EXPERIMENTS,
    LIGHTWEIGHT_COST_VARIANTS,
)
from scripts.patcheval.workspace_state import (
    WORKSPACE_DIR_RE,
    dataset_cves,
    experiment_state,
    first_workspace_patch,
    observed_cves,
)

EXPERIMENT_RE = re.compile(r"^(CVE-\d+-\d+)-(.+)$")
# The collector reports a materialized patch as "present" whether or not it is empty.
_COLLECT_STATUS = {"complete": "present", "empty-patch": "present"}


@dataclass
class PatchRecord:
    cve: str
    tag: str
    experiment: str
    run_id: str
    patch_path: str | None
    bytes: int
    lines: int
    is_empty: bool
    source_experiment: str | None = None
    patch_source: str = "workspace.patch"
    retry_count_used: int | None = None
    synthetic: bool = False
    missing_reason: str | None = None


def _retry_count(run_dir: Path) -> int | None:
    # Retry inference is only a PatchEval issue-CVE reporting hint. Read both
    # the canonical stage trajectories and the current flat published view.
    artifacts = run_dir / "artifacts" / run_dir.name
    retry_indexes: list[int] = []
    for trajectory_path in artifacts.glob("**/trajectories/retry-*.jsonl"):
        label = trajectory_path.stem
        try:
            retry_indexes.append(int(label.split("-", 1)[1]))
        except (IndexError, ValueError):
            continue
    for trajectory_path in artifacts.glob("trajectories/*-retry-*.jsonl"):
        match = re.search(r"-retry-(\d+)$", trajectory_path.stem)
        if match:
            retry_indexes.append(int(match.group(1)))
    if retry_indexes:
        return max(retry_indexes)
    if any(artifacts.glob("**/trajectories/initial.jsonl")) or any(
        artifacts.glob("trajectories/*-initial.jsonl")
    ):
        return 0
    return None


def _initial_mitigator_patch(run_dir: Path) -> tuple[Path, str] | None:
    artifacts = run_dir / "artifacts" / run_dir.name / "mitigator"
    initial_patch = artifacts / "workspace.initial.patch"
    final_patch = artifacts / "workspace.patch"
    if initial_patch.is_file():
        return initial_patch, "workspace.initial.patch"
    if final_patch.is_file():
        return final_patch, "workspace.patch"
    return None


def _synthetic_empty_record(
    *,
    cve: str,
    tag: str,
    experiment: str,
    root: Path,
) -> PatchRecord:
    source_experiment = None
    status_experiment = experiment
    for original, lightweight in LIGHTWEIGHT_COST_VARIANTS.items():
        if experiment == lightweight:
            source_experiment = original
            status_experiment = original
            break

    state = experiment_state(root=root, tag=tag, cve=cve, experiment=status_experiment)
    return PatchRecord(
        cve=cve,
        tag=tag,
        experiment=experiment,
        run_id=state.run_id or "",
        patch_path=None,
        bytes=0,
        lines=0,
        is_empty=True,
        source_experiment=source_experiment,
        patch_source="synthetic-empty-missing-artifact",
        retry_count_used=None,
        synthetic=True,
        missing_reason=_COLLECT_STATUS.get(state.status, state.status),
    )


def _record_from_patch(
    *,
    cve: str,
    tag: str,
    experiment: str,
    patch_path: Path,
    source_experiment: str | None = None,
    patch_source: str = "workspace.patch",
    retry_count_used: int | None = None,
) -> PatchRecord:
    content = patch_path.read_text(encoding="utf-8", errors="replace")
    return PatchRecord(
        cve=cve,
        tag=tag,
        experiment=experiment,
        run_id=patch_path.parts[-3],
        patch_path=str(patch_path),
        bytes=len(content.encode("utf-8")),
        lines=content.count("\n"),
        is_empty=(content.strip() == ""),
        source_experiment=source_experiment,
        patch_source=patch_source,
        retry_count_used=retry_count_used,
    )


def collect(root: Path, tag: str) -> list[PatchRecord]:
    records: list[PatchRecord] = []
    for workspace_dir in sorted(root.glob(f".agent-workspace-patcheval-CVE-*-{tag}")):
        match = WORKSPACE_DIR_RE.match(workspace_dir.name)
        if not match:
            continue
        cve, workspace_tag = match.groups()
        for experiment_dir in sorted(workspace_dir.glob(f"{cve}-*")):
            if not experiment_dir.is_dir():
                continue
            exp_match = EXPERIMENT_RE.match(experiment_dir.name)
            if not exp_match:
                continue
            experiment = exp_match.group(2)
            patch_path = first_workspace_patch(experiment_dir)
            if patch_path is None:
                continue
            records.append(
                _record_from_patch(
                    cve=cve,
                    tag=workspace_tag,
                    experiment=experiment,
                    patch_path=patch_path,
                )
            )
            if experiment in LIGHTWEIGHT_COST_VARIANTS:
                run_dir = experiment_dir.resolve()
                patch_info = _initial_mitigator_patch(run_dir)
                if patch_info is None:
                    continue
                lightweight_patch_path, patch_source = patch_info
                records.append(
                    _record_from_patch(
                        cve=cve,
                        tag=workspace_tag,
                        experiment=LIGHTWEIGHT_COST_VARIANTS[experiment],
                        patch_path=lightweight_patch_path,
                        source_experiment=experiment,
                        patch_source=patch_source,
                        retry_count_used=_retry_count(run_dir),
                    )
                )
    return records


def fill_missing_empty_records(
    *,
    records: list[PatchRecord],
    root: Path,
    tag: str,
    cves: list[str],
) -> list[PatchRecord]:
    by_key = {(record.cve, record.experiment): record for record in records}
    filled: list[PatchRecord] = []
    for cve in cves:
        for experiment in EVALUATION_EXPERIMENTS:
            record = by_key.get((cve, experiment))
            if record is not None:
                filled.append(record)
            else:
                filled.append(
                    _synthetic_empty_record(
                        cve=cve,
                        tag=tag,
                        experiment=experiment,
                        root=root,
                    )
                )
    return filled


def write_patch_json(path: Path, records: list[PatchRecord]) -> None:
    payload = []
    for record in records:
        patch = (
            Path(record.patch_path).read_text(encoding="utf-8", errors="replace")
            if record.patch_path
            else ""
        )
        payload.append(
            {
                "cve": record.cve,
                "fix_patch": patch,
            }
        )
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Collect PatchEval workspace.patch files into run_evaluation.py patch JSON files."
    )
    parser.add_argument(
        "--root",
        default=".",
        help="repository root containing .agent-workspace-patcheval-* dirs",
    )
    parser.add_argument(
        "--tag", default="DEEPSEEK-V4-PRO", help="workspace tag suffix to collect"
    )
    parser.add_argument(
        "--dataset",
        default="PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json",
        help="PatchEval dataset used to enumerate CVEs when --fill-missing-empty and --fill-from-dataset are both enabled.",
    )
    parser.add_argument(
        "--output-dir",
        default="evaluation_input",
        help="directory for generated JSON files",
    )
    parser.add_argument(
        "--no-fill-missing-empty",
        dest="fill_missing_empty",
        action="store_false",
        help=(
            "do not emit synthetic empty patch records for missing variant-CVE artifacts; this reverts to "
            "patch-artifact-only collection"
        ),
    )
    parser.set_defaults(fill_missing_empty=True)
    parser.add_argument(
        "--fill-from-dataset",
        action="store_true",
        help="fill all CVEs in --dataset instead of only observed workspace CVEs",
    )
    parser.add_argument(
        "--exclude-empty",
        action="store_true",
        help="exclude empty workspace.patch files; do not use for leaderboard-style evaluation",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = root / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    dataset_path = Path(args.dataset)
    if not dataset_path.is_absolute():
        dataset_path = root / dataset_path

    records = collect(root, args.tag)
    if args.fill_missing_empty:
        cves = (
            dataset_cves(dataset_path)
            if args.fill_from_dataset
            else observed_cves(root=root, tag=args.tag)
        )
        records = fill_missing_empty_records(
            records=records,
            root=root,
            tag=args.tag,
            cves=cves,
        )
    selected = (
        [record for record in records if not record.is_empty]
        if args.exclude_empty
        else records
    )
    all_name = "all-nonempty" if args.exclude_empty else "all"

    manifest_path = output_dir / f"patcheval-{args.tag}-manifest.json"
    manifest_path.write_text(
        json.dumps([asdict(record) for record in records], indent=2),
        encoding="utf-8",
    )

    experiments = [
        experiment
        for experiment in EVALUATION_EXPERIMENTS
        if any(record.experiment == experiment for record in selected)
    ]
    for experiment in experiments:
        experiment_records = [
            record for record in selected if record.experiment == experiment
        ]
        write_patch_json(
            output_dir / f"patcheval-{args.tag}-{experiment}.json", experiment_records
        )

    write_patch_json(output_dir / f"patcheval-{args.tag}-{all_name}.json", selected)

    print(f"manifest: {manifest_path}")
    print(f"records: {len(records)} total, {len(selected)} selected")
    for experiment in experiments:
        count = sum(1 for record in selected if record.experiment == experiment)
        print(f"{experiment}: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
