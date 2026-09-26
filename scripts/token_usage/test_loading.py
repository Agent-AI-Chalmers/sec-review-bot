import json
from pathlib import Path

from scripts.token_usage.loading import _artifact_root, load_run_usage


def test_artifact_root_accepts_direct_integrated_run(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-123"
    (run_dir / "analyzer").mkdir(parents=True)

    assert _artifact_root(run_dir) == run_dir


def test_artifact_root_accepts_nested_run_layout(tmp_path: Path) -> None:
    run_dir = tmp_path / "local-run-123"
    artifact_root = run_dir / "artifacts" / run_dir.name
    artifact_root.mkdir(parents=True)

    assert _artifact_root(run_dir) == artifact_root


def test_artifact_root_accepts_outer_run_artifacts_directory(tmp_path: Path) -> None:
    run_dir = tmp_path / "local-run-123"
    artifact_root = run_dir / "artifacts"
    artifact_root.mkdir(parents=True)

    assert _artifact_root(run_dir) == artifact_root


def test_load_run_usage_reads_direct_integrated_artifact_root(
    tmp_path: Path,
) -> None:
    run_dir = tmp_path / "run-123"
    analyzer_dir = run_dir / "analyzer"
    analyzer_dir.mkdir(parents=True)
    (analyzer_dir / "transcript.json").write_text(
        json.dumps(
            [
                {
                    "type": "ai",
                    "usage_metadata": {
                        "input_tokens": 12,
                        "output_tokens": 3,
                        "total_tokens": 15,
                    },
                    "response_metadata": {
                        "model_name": "test-model",
                        "model_provider": "test-provider",
                    },
                }
            ]
        ),
        encoding="utf-8",
    )

    usage = load_run_usage(run_dir)

    assert len(usage.stages) == 1
    assert usage.stages[0].stage == "analyzer"
    assert usage.stages[0].model_id == "test-provider/test-model"
    assert usage.stages[0].total_tokens == 15
