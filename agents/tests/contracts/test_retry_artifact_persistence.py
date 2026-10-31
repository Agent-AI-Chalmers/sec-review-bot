import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sec_review_agents.filesystem.backend_factory import BackendConfig
from sec_review_agents.agents.mitigation.model import MitigationOutput
from sec_review_agents.review_stages.mitigation.stage import (
    create_skipped_mitigation_result,
    persist_mitigation_result,
)
from sec_review_agents.review_stages.verification.stage import (
    create_skipped_verification_result,
    persist_verification_result,
    reset_verification_attempt_artifacts,
    verification_attempt_label,
)
from sec_review_agents.runtime.trajectories import TrajectoryWriter
from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
)


def test_mitigation_trajectories_are_scoped_by_business_attempt(
    tmp_path: Path,
) -> None:
    root = tmp_path

    TrajectoryWriter((root / "trajectories" / "initial.jsonl",)).write_messages([])
    TrajectoryWriter((root / "trajectories" / "retry-1.jsonl",)).write_messages([])

    assert (root / "trajectories" / "initial.jsonl").exists()
    assert (root / "trajectories" / "retry-1.jsonl").exists()


def test_verification_trajectories_are_scoped_by_business_attempt(
    tmp_path: Path,
) -> None:
    root = tmp_path

    TrajectoryWriter((root / "trajectories" / "initial.jsonl",)).write_messages([])
    TrajectoryWriter((root / "trajectories" / "retry-1.jsonl",)).write_messages([])

    assert (root / "trajectories" / "initial.jsonl").exists()
    assert (root / "trajectories" / "retry-1.jsonl").exists()


def test_initial_mitigation_attempt_clears_stale_attempt_archives(
    tmp_path: Path,
) -> None:
    root = tmp_path
    (root / "trajectories").mkdir(parents=True)
    (root / "trajectories" / "initial.jsonl").write_text("stale", encoding="utf-8")
    (root / "trajectories" / "retry-1.jsonl").write_text("stale", encoding="utf-8")
    for filename in (
        "mitigation-result.initial.json",
        "workspace.initial.patch",
        "mitigation-result.retry-1.json",
        "workspace.retry-1.patch",
    ):
        (root / filename).write_text("stale", encoding="utf-8")

    create_skipped_mitigation_result(
        mitigator_artifacts_path=root,
        retry_context=None,
        reason="no target",
    )

    assert (root / "mitigation-result.json").exists()
    assert (root / "workspace.patch").exists()
    assert not (root / "mitigation-result.initial.json").exists()
    assert not (root / "workspace.initial.patch").exists()
    assert not (root / "mitigation-result.retry-1.json").exists()
    assert not (root / "workspace.retry-1.patch").exists()
    assert not (root / "trajectories" / "initial.jsonl").exists()
    assert not (root / "trajectories" / "retry-1.jsonl").exists()


def test_retry_mitigation_attempt_preserves_initial_archive(tmp_path: Path) -> None:
    root = tmp_path
    (root / "trajectories").mkdir(parents=True)
    (root / "trajectories" / "initial.jsonl").write_text("initial", encoding="utf-8")
    (root / "trajectories" / "retry-1.jsonl").write_text("retry", encoding="utf-8")
    initial_files = (
        "mitigation-result.initial.json",
        "workspace.initial.patch",
    )
    for filename in initial_files:
        (root / filename).write_text("initial", encoding="utf-8")

    create_skipped_mitigation_result(
        mitigator_artifacts_path=root,
        retry_context={"retry_index": 1},
        reason="no target",
    )

    for filename in initial_files:
        assert (root / filename).read_text(encoding="utf-8") == "initial"
    assert (root / "mitigation-result.retry-1.json").exists()
    assert (root / "workspace.retry-1.patch").exists()
    assert (root / "trajectories" / "initial.jsonl").read_text(
        encoding="utf-8"
    ) == "initial"
    assert not (root / "trajectories" / "retry-1.jsonl").exists()


def test_mitigation_persists_latest_and_attempt_specific_files(
    tmp_path: Path,
) -> None:
    root = tmp_path
    result = {
        "overview": "retry",
    }

    persist_mitigation_result(root, result, attempt_label="retry-1")

    latest = json.loads((root / "mitigation-result.json").read_text())
    retry_copy = json.loads((root / "mitigation-result.retry-1.json").read_text())
    assert latest["overview"] == "retry"
    assert retry_copy["overview"] == "retry"


def test_verification_persists_latest_and_attempt_specific_files(
    tmp_path: Path,
) -> None:
    root = tmp_path
    result = {"overview": "verified"}

    persist_verification_result(root, result, attempt_label="retry-1")

    latest = json.loads((root / "verification-result.json").read_text())
    retry_copy = json.loads((root / "verification-result.retry-1.json").read_text())
    assert latest["overview"] == "verified"
    assert retry_copy["overview"] == "verified"


def test_skipped_verification_persists_explicit_stage_result(tmp_path: Path) -> None:
    result = create_skipped_verification_result(
        verifier_artifacts_path=tmp_path,
        retry_context=None,
        reason="No confirmed repair target.",
    )

    persisted = json.loads((tmp_path / "verification-result.json").read_text())
    assert result == persisted
    assert result["overview"] == "No confirmed repair target."
    assert result["patch_coverage"] is None
    assert result["resolution_next_step"] == "none"


def test_verification_attempt_reset_uses_retry_context_for_attempt_label(
    tmp_path: Path,
) -> None:
    verifier_root = tmp_path / "verifier"
    verifier_root.mkdir()
    (verifier_root / "verification-result.json").write_text("stale", encoding="utf-8")
    (verifier_root / "verification-result.retry-1.json").write_text(
        "stale retry",
        encoding="utf-8",
    )
    (verifier_root / "verification-result.initial.json").write_text(
        "initial",
        encoding="utf-8",
    )

    attempt_label = verification_attempt_label({"retry_index": 1})
    reset_verification_attempt_artifacts(
        verifier_root,
        attempt_label=attempt_label,
    )

    assert attempt_label == "retry-1"
    assert not (verifier_root / "verification-result.json").exists()
    assert not (verifier_root / "verification-result.retry-1.json").exists()
    assert (verifier_root / "verification-result.initial.json").exists()


@pytest.mark.asyncio
async def test_run_mitigation_persists_retry_artifacts_with_retry_label(
    tmp_path: Path,
) -> None:
    root = tmp_path
    mitigator_root = root / "mitigator"
    local_root = root / "local-root"
    workspace_root = local_root / "workspace"
    workspace_root.mkdir(parents=True)
    (workspace_root / "demo.txt").write_text("before\n", encoding="utf-8")
    create_workspace_snapshot_tar(
        workspace_path=workspace_root,
        tar_path=root / WORKSPACE_SNAPSHOT_TAR_NAME,
    )

    retry_context: dict[str, object] = {
        "retry_index": 1,
        "previous_mitigation_result": None,
        "previous_verifier_result": None,
        "history": [],
    }
    structured_payload = {
        "overview": "retry patch",
        "declared_changed_files": ["demo.txt"],
        "residual_risks": [],
    }

    async def fake_run_agent(**kwargs):
        assert kwargs["trajectory_paths"] == (
            mitigator_root / "trajectories" / "retry-1.jsonl",
        )
        return MitigationOutput.model_validate(structured_payload)

    def fake_build_patch_artifact(
        workspace_path,
        *,
        include_paths,
    ):
        _ = workspace_path
        assert include_paths == ["demo.txt"]
        return {
            "patch_diff": "diff --git a/demo.txt b/demo.txt\n",
            "file_changes": [{"path": "demo.txt", "status": "deleted"}],
        }

    with (
        patch(
            "sec_review_agents.review_stages.mitigation.stage.run_mitigation_agent",
            side_effect=fake_run_agent,
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.build_patch_artifact",
            side_effect=fake_build_patch_artifact,
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.result.build_mitigation_stage_result",
            side_effect=lambda **kwargs: kwargs,
        ),
    ):
        from sec_review_agents.review_stages.mitigation.stage import (
            run_mitigation_stage,
        )

        await run_mitigation_stage(
            agent_name="mitigation-agent",
            mitigator_artifacts_path=mitigator_root,
            baseline_snapshot_tar_path=root / WORKSPACE_SNAPSHOT_TAR_NAME,
            retry_context=retry_context,
            build_backend_config=lambda _workspace_path: BackendConfig(
                container_name_prefix="test",
                path_views=[],
                image=None,
                backend_kind="local",
            ),
            system_prompt="base",
            filesystem_system_prompt="fs",
            user_prompt="user",
        )

    assert (mitigator_root / "workspace.retry-1.patch").exists()
    assert (mitigator_root / "mitigation-result.retry-1.json").exists()
