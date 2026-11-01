"""Regression probes for CI aggregation and dependency coverage.

Run with python3 .github/ci/test_ci.py. YAML is parsed through the same Ruby
library used by the validators; these probes require no Python dependencies.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_workflow() -> dict:
    result = subprocess.run(
        [
            "ruby",
            "-ryaml",
            "-rjson",
            "-e",
            'puts JSON.generate(YAML.load_file(".github/workflows/ci.yml"))',
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_aggregate_results() -> None:
    """Every dependency, including change detection, must propagate failures."""
    job = read_workflow()["jobs"]["ci-status"]
    assert job["if"] == "always()"
    step = job["steps"][0]
    assert step["env"]["NEEDS_JSON"] == "${{ toJSON(needs) }}"
    baseline = {name: {"result": "success"} for name in job["needs"]}
    cases = [(baseline, True)]
    cases.append(({name: {"result": "skipped"} for name in baseline}, True))
    for name in baseline:
        for result in ("failure", "cancelled", "unknown"):
            cases.append(({**baseline, name: {"result": result}}, False))
    for needs, expected_success in cases:
        result = subprocess.run(
            ["bash", "-c", step["run"]],
            check=False,
            env={**os.environ, "NEEDS_JSON": json.dumps(needs)},
            capture_output=True,
            text=True,
        )
        assert (result.returncode == 0) == expected_success, result.stderr
        for name, details in needs.items():
            if details["result"] not in {"success", "skipped"}:
                assert f"{name}: {details['result']}" in result.stderr


def test_dependency_coverage() -> None:
    """A newly added or disconnected job must not silently escape CI Status."""
    workflow = read_workflow()
    for mutation in ("none", "missing", "new", "unknown"):
        fixture = json.loads(json.dumps(workflow))
        jobs = fixture["jobs"]
        if mutation == "missing":
            jobs["ci-status"]["needs"].remove("agents")
        elif mutation == "new":
            jobs["new-check"] = {"runs-on": "ubuntu-latest", "steps": []}
        elif mutation == "unknown":
            jobs["ci-status"]["needs"].append("unknown")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".github/workflows/ci.yml"
            path.parent.mkdir(parents=True)
            # JSON is a YAML subset, so fixtures exercise the real YAML reader.
            path.write_text(json.dumps(fixture))
            result = subprocess.run(
                ["ruby", str(ROOT / ".github/ci/check-ci-status-dependencies.rb")],
                cwd=directory,
                check=False,
                capture_output=True,
                text=True,
            )
            assert (result.returncode == 0) == (mutation == "none"), result.stderr


if __name__ == "__main__":
    for test in (
        test_aggregate_results,
        test_dependency_coverage,
    ):
        test()
        print(f"ok: {test.__name__}")
