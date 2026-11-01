import json
import subprocess
import sys
from pathlib import Path

from scripts.patcheval.collect_patcheval_patches import fill_missing_empty_records


def test_fill_only_selected_variant(tmp_path):
    records = fill_missing_empty_records(
        records=[],
        root=tmp_path,
        tag="C0",
        cves=["CVE-2024-1234"],
        variants=("end-to-end-default",),
    )
    assert len(records) == 1
    assert records[0].experiment == "end-to-end-default"
    assert records[0].synthetic
    assert records[0].missing_reason == "missing-workspace"


def test_collector_cli_does_not_invent_unselected_experiments(tmp_path):
    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps([{"cve_id": "CVE-2024-1234"}]))
    output = tmp_path / "output"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.patcheval.collect_patcheval_patches",
            "--root",
            str(tmp_path),
            "--dataset",
            str(dataset),
            "--tag",
            "C0",
            "--variant",
            "end-to-end-default",
            "--fill-from-dataset",
            "--incomplete",
            "empty",
            "--output-dir",
            str(output),
        ],
        cwd=Path(__file__).resolve().parents[2],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "records: 1 total, 1 selected" in result.stdout
    assert {p.name for p in output.glob("*.json")} == {
        "patcheval-C0-manifest.json",
        "patcheval-C0-end-to-end-default.json",
        "patcheval-C0-all.json",
    }
    assert json.loads(
        (output / "patcheval-C0-end-to-end-default.json").read_text()
    ) == [{"cve": "CVE-2024-1234", "fix_patch": ""}]
