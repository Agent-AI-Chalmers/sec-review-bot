from pathlib import Path

from scripts.replay.input_bundle import default_replay_artifact_root
from scripts.replay.repository_discovery import _run_id_from_replay_input


def test_discovery_replay_uses_materialized_artifact_run_id(
    tmp_path: Path, monkeypatch
) -> None:
    run_id = "replay-run-123"
    discovery_path = tmp_path / run_id / "discovery"
    replay_input = {"artifact_paths": {"discovery": str(discovery_path)}}
    configured_root = tmp_path / "configured-artifacts"
    monkeypatch.setenv("SEC_REVIEW_AGENT_ARTIFACT_ROOT", str(configured_root))

    materialized_run_id = _run_id_from_replay_input(replay_input)

    assert materialized_run_id == run_id
    assert (
        default_replay_artifact_root(
            input_bundle_root=tmp_path / "input-bundle",
            run_id=materialized_run_id,
        )
        == configured_root / run_id
    )
