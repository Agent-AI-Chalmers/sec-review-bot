from pathlib import Path

from scripts.replay.input_bundle import default_replay_artifact_root
from scripts.replay.repository_discovery import _run_id_from_replay_input
from sec_review_agents.scan_stages.input import RepositoryScanScope
from sec_review_agents.workflows.prepared_input import PreparedRepositoryInput
from sec_review_agents.workflows.review_intent import ReviewIntent


def test_discovery_replay_uses_materialized_artifact_run_id(
    tmp_path: Path, monkeypatch
) -> None:
    run_id = "replay-run-123"
    discovery_path = tmp_path / run_id / "discovery"
    replay_input = PreparedRepositoryInput(
        input_bundle_root_path=str(tmp_path / "bundle"),
        artifact_root_path=str(discovery_path.parent),
        workspace_snapshot_tar_path=str(tmp_path / "workspace.tar"),
        history_path=str(tmp_path / "history.json"),
        review_intent=ReviewIntent(objective="repair", test_changes="allow"),
        scan_mode="full",
        scan_scope=RepositoryScanScope(paths_ignore=[], incremental_changed_files=[]),
        discovery_artifacts_path=str(discovery_path),
        triage_artifacts_path=str(discovery_path.parent / "triage"),
        cases_artifacts_path=str(discovery_path.parent / "cases"),
    )
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


def test_discovery_replay_keeps_default_artifacts_beside_local_input(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.delenv("SEC_REVIEW_AGENT_ARTIFACT_ROOT", raising=False)
    assert (
        default_replay_artifact_root(input_bundle_root=tmp_path / "input")
        == tmp_path / "artifacts"
    )
