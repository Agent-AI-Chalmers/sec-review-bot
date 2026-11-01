"""Production TS producer and Python consumer exchange an actual stored bundle."""

import json
import os
import subprocess
import tarfile
import uuid
from pathlib import Path

import pytest
from sec_review_agents.entrypoints.input_preparation import prepare_workflow_input

ROOT = Path(__file__).resolve().parents[2]


def test_typescript_bundle_materializes_in_python(object_store, monkeypatch, tmp_path):
    """Validate real archive bytes and reject a mismatched digest before use."""
    for key, value in object_store.items():
        monkeypatch.setenv(key, value)
    run_id = f"bundle-{uuid.uuid4().hex}"
    output = tmp_path / "reference.json"
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/system-tests/publish-input.mjs"),
            str(tmp_path / "producer"),
            run_id,
            str(output),
        ],
        cwd=ROOT,
        env={**os.environ, **object_store},
        check=True,
        timeout=30,
        text=True,
    )
    reference = json.loads(output.read_text())
    input_data = json.loads(
        (
            ROOT / "contracts/execution-api/v1/fixtures/issue-review-input.json"
        ).read_text()
    )
    input_data["input_bundle"] = reference
    prepared = prepare_workflow_input(
        input_data,
        "issue-review",
        artifact_root_path=tmp_path / "artifacts",
        expected_run_id=run_id,
    )
    with tarfile.open(prepared.workspace_snapshot_tar_path) as archive:
        content = archive.extractfile("probe.txt")
        assert content is not None
        assert content.read().decode() == "跨语言 bundle\n"
    assert json.loads((Path(prepared.history_path) / "issue.json").read_text()) == {
        "number": 1
    }
    input_data["input_bundle"] = {**reference, "digest": f"sha256:{'0' * 64}"}
    with pytest.raises(ValueError):
        prepare_workflow_input(
            input_data,
            "issue-review",
            artifact_root_path=tmp_path / "bad-artifacts",
        )
