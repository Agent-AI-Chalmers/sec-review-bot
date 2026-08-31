#!/usr/bin/env python3
import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

WORKSPACE_RE = re.compile(r"^\.agent-workspace-patcheval-(CVE-\d+-\d+)-(.+)$")
EXPERIMENT_RE = re.compile(r"^(CVE-\d+-\d+)-(.+)$")
# lightweight-two-stage records are derived from default run artifacts, not
# collected from a separately executed PatchEval experiment.
LIGHTWEIGHT_TWO_STAGE_SOURCES = {
    "end-to-end-default": "end-to-end-lightweight-two-stage",
    "location-oracle-default": "location-oracle-lightweight-two-stage",
}
BASE_EXPERIMENTS = [
    "end-to-end-default",
    "end-to-end-single-agent",
    "end-to-end-two-stage",
    "location-oracle-default",
    "location-oracle-single-agent",
    "location-oracle-two-stage",
]
EVALUATION_EXPERIMENTS = [
    "end-to-end-default",
    "end-to-end-lightweight-two-stage",
    "end-to-end-single-agent",
    "end-to-end-two-stage",
    "location-oracle-default",
    "location-oracle-lightweight-two-stage",
    "location-oracle-single-agent",
    "location-oracle-two-stage",
]


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


def _first_workspace_patch(experiment_dir: Path) -> Path | None:
    # PatchEval CVE experiments currently run issue/PR-style workflows. This
    # broad fallback is intentionally not repository-delivery-aware; do not use
    # it to infer publishable repository review delivery artifacts.
    artifacts = experiment_dir / "artifacts"
    if not artifacts.is_dir():
        return None
    patches = sorted(artifacts.glob("*/**/workspace.patch"))
    return patches[0] if patches else None


def _retry_count(run_dir: Path) -> int | None:
    # Retry inference is only a PatchEval issue-CVE reporting hint. Repository
    # review publishes a run-level transcript view for memory extraction; that
    # view is not a general token/cost or delivery contract.
    artifacts = run_dir / "artifacts" / run_dir.name
    retry_indexes: list[int] = []
    for transcript_path in artifacts.glob("**/transcripts/retry-*.jsonl"):
        label = transcript_path.stem
        try:
            retry_indexes.append(int(label.split("-", 1)[1]))
        except (IndexError, ValueError):
            continue
    for transcript_path in artifacts.glob("transcripts/*/*-retry-*.jsonl"):
        match = re.search(r"-retry-(\d+)$", transcript_path.stem)
        if match:
            retry_indexes.append(int(match.group(1)))
    if retry_indexes:
        return max(retry_indexes)
    if any(artifacts.glob("**/transcripts/initial.jsonl")) or any(
        artifacts.glob("transcripts/*/*-initial.jsonl")
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


def _read_dataset_cves(dataset_path: Path) -> list[str]:
    try:
        data = json.loads(dataset_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = None
    if not isinstance(data, list):
        raise ValueError(f"PatchEval dataset must be a JSON list: {dataset_path}")

    cves: list[str] = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("cve_id"), str):
            cves.append(item["cve_id"])
    if not cves:
        raise ValueError(
            f"PatchEval dataset did not contain any cve_id values: {dataset_path}"
        )
    return cves


def _observed_cves(root: Path, tag: str) -> list[str]:
    cves: list[str] = []
    for workspace_dir in sorted(root.glob(f".agent-workspace-patcheval-CVE-*-{tag}")):
        match = WORKSPACE_RE.match(workspace_dir.name)
        if match:
            cves.append(match.group(1))
    if not cves:
        raise ValueError(
            f"No observed PatchEval workspaces found for tag {tag!r} under {root}"
        )
    return cves


def _experiment_status(
    root: Path, tag: str, cve: str, experiment: str
) -> tuple[str, str | None]:
    workspace_dir = root / f".agent-workspace-patcheval-{cve}-{tag}"
    experiment_dir = workspace_dir / f"{cve}-{experiment}"

    if not workspace_dir.exists():
        return "missing-workspace", None
    if not workspace_dir.is_dir():
        return "blocked-workspace", None
    if not experiment_dir.exists():
        return "missing-symlink", None
    if not experiment_dir.is_symlink():
        return "blocked-non-symlink", None

    try:
        run_dir = experiment_dir.resolve(strict=True)
    except OSError:
        return "missing-target", None
    if not run_dir.is_dir():
        return "missing-target", None

    exit_code_path = run_dir / "exit-code.txt"
    if not exit_code_path.is_file():
        return "missing-exit-code", run_dir.name
    exit_code = exit_code_path.read_text(encoding="utf-8", errors="replace").strip()
    if exit_code != "0":
        return f"exit-{exit_code or 'unknown'}", run_dir.name

    if _first_workspace_patch(run_dir) is None:
        return "missing-patch", run_dir.name

    return "present", run_dir.name


def _synthetic_empty_record(
    *,
    cve: str,
    tag: str,
    experiment: str,
    root: Path,
) -> PatchRecord:
    source_experiment = None
    status_experiment = experiment
    for original, lightweight in LIGHTWEIGHT_TWO_STAGE_SOURCES.items():
        if experiment == lightweight:
            source_experiment = original
            status_experiment = original
            break

    missing_reason, run_id = _experiment_status(root, tag, cve, status_experiment)
    return PatchRecord(
        cve=cve,
        tag=tag,
        experiment=experiment,
        run_id=run_id or "",
        patch_path=None,
        bytes=0,
        lines=0,
        is_empty=True,
        source_experiment=source_experiment,
        patch_source="synthetic-empty-missing-artifact",
        retry_count_used=None,
        synthetic=True,
        missing_reason=missing_reason,
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
        match = WORKSPACE_RE.match(workspace_dir.name)
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
            patch_path = _first_workspace_patch(experiment_dir)
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
            if experiment in LIGHTWEIGHT_TWO_STAGE_SOURCES:
                run_dir = experiment_dir.resolve()
                patch_info = _initial_mitigator_patch(run_dir)
                if patch_info is None:
                    continue
                lightweight_patch_path, patch_source = patch_info
                records.append(
                    _record_from_patch(
                        cve=cve,
                        tag=workspace_tag,
                        experiment=LIGHTWEIGHT_TWO_STAGE_SOURCES[experiment],
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
            _read_dataset_cves(dataset_path)
            if args.fill_from_dataset
            else _observed_cves(root, args.tag)
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
