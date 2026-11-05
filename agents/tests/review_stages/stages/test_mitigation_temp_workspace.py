import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.agents.mitigation.model import MitigationOutput
from sec_review_agents.filesystem.backend_factory import BackendConfig
from sec_review_agents.review_stages.mitigation.stage import (
    run_mitigation_stage,
)
from sec_review_agents.workspace.patches import PatchArtifact
from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
)


def _build_base_materialization(root: Path) -> dict:
    local_root = root / "local"
    workspace_root = local_root / "workspace"
    workspace_root.mkdir(parents=True, exist_ok=True)
    (workspace_root / "src").mkdir(parents=True, exist_ok=True)
    (workspace_root / "src" / "app.js").write_text(
        "console.log('ok')\n", encoding="utf-8"
    )
    return {
        "local_root_path": str(local_root),
    }


def _add_snapshot_seed(materialization: dict) -> None:
    local_root = Path(materialization["local_root_path"])
    create_workspace_snapshot_tar(
        workspace_path=local_root / "workspace",
        tar_path=local_root / WORKSPACE_SNAPSHOT_TAR_NAME,
    )


async def _run_mitigation_stage_for_workspace_capture(
    *,
    tmp_path: Path,
    workspace_snapshot_tar_path: Path,
) -> list[Path]:
    captured_workspace_paths: list[Path] = []

    def build_backend(workspace_path: Path) -> BackendConfig:
        assert (workspace_path / "src" / "app.js").exists()
        captured_workspace_paths.append(workspace_path)
        return BackendConfig(
            container_name_prefix="test",
            path_views=[],
            image=None,
            backend_kind="local",
        )

    async def run_agent(**_kwargs: Any) -> MitigationOutput:
        return MitigationOutput.model_validate(
            {
                "overview": "No changes needed.",
            }
        )

    with (
        patch(
            "sec_review_agents.review_stages.mitigation.stage.resolve_workspace_commit",
            return_value="baseline",
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.run_mitigation_agent",
            side_effect=run_agent,
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.build_committed_patch",
            return_value=PatchArtifact(file_changes=[], patch_diff=""),
        ),
    ):
        await run_mitigation_stage(
            agent_name="mitigator",
            mitigator_artifacts_path=tmp_path / "artifacts" / "mitigator",
            workspace_snapshot_tar_path=workspace_snapshot_tar_path,
            retry_context=None,
            build_backend_config=build_backend,
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="user",
        )

    return captured_workspace_paths


@pytest.mark.asyncio
async def test_run_mitigation_stage_uses_system_temp_workspace(
    tmp_path: Path,
) -> None:
    materialization = _build_base_materialization(tmp_path)
    _add_snapshot_seed(materialization)
    local_root = Path(materialization["local_root_path"])
    run_artifacts = local_root / "artifacts"

    captured_workspace_paths = await _run_mitigation_stage_for_workspace_capture(
        tmp_path=tmp_path,
        workspace_snapshot_tar_path=local_root / WORKSPACE_SNAPSHOT_TAR_NAME,
    )
    assert len(captured_workspace_paths) == 1
    workspace_path = captured_workspace_paths[0]
    assert not workspace_path.exists()
    assert workspace_path.parent == Path(tempfile.gettempdir())
    assert workspace_path.name.startswith("sec-review-mitigation-")
    assert not str(workspace_path).startswith(str(run_artifacts))


@pytest.mark.asyncio
async def test_run_mitigation_stage_requires_snapshot_seed(tmp_path: Path) -> None:
    materialization = _build_base_materialization(tmp_path)

    with pytest.raises(FileNotFoundError):
        await _run_mitigation_stage_for_workspace_capture(
            tmp_path=tmp_path,
            workspace_snapshot_tar_path=Path(materialization["local_root_path"])
            / WORKSPACE_SNAPSHOT_TAR_NAME,
        )


@pytest.mark.asyncio
async def test_stage_exports_commits_from_pinned_baseline(tmp_path: Path) -> None:
    """Exercise stage baseline capture and real export, rather than mocking the artifact."""
    import subprocess

    from sec_review_agents.workspace.commits import resolve_workspace_commit
    from sec_review_agents.workspace.patches import (
        check_workspace_patch_applies_to_fresh_baseline,
    )

    materialization = _build_base_materialization(tmp_path)
    local_root = Path(materialization["local_root_path"])
    seed = local_root / "workspace"

    def git(workspace: Path, *args: str) -> None:
        subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True)

    git(seed, "init")
    git(seed, "config", "user.name", "Test")
    git(seed, "config", "user.email", "test@localhost")
    git(seed, "add", ".")
    git(seed, "commit", "-qm", "baseline")
    baseline = resolve_workspace_commit(seed)
    _add_snapshot_seed(materialization)
    snapshot = local_root / WORKSPACE_SNAPSHOT_TAR_NAME

    async def run_agent(**kwargs: Any) -> MitigationOutput:
        workspace = kwargs["workspace_root_path"]
        assert kwargs["baseline_commit"] == baseline
        (workspace / "src/app.js").write_text("fixed\n")
        git(workspace, "commit", "-qam", "repair")
        (workspace / "regression.txt").write_text("test evidence\n")
        git(workspace, "add", "regression.txt")
        git(workspace, "commit", "-qm", "regression")
        (workspace / "src/app.js").write_text("uncommitted experiment\n")
        return MitigationOutput(overview="Committed repair and regression coverage.")

    with patch(
        "sec_review_agents.review_stages.mitigation.stage.run_mitigation_agent",
        side_effect=run_agent,
    ):
        result = await run_mitigation_stage(
            agent_name="mitigator",
            mitigator_artifacts_path=tmp_path / "artifacts",
            workspace_snapshot_tar_path=snapshot,
            retry_context=None,
            build_backend_config=lambda _: BackendConfig(
                container_name_prefix="test",
                path_views=[],
                image=None,
                backend_kind="local",
            ),
            system_prompt="system",
            filesystem_system_prompt="filesystem",
            user_prompt="repair",
        )
    assert {c["path"]: c.get("content") for c in result.file_changes} == {
        "src/app.js": "fixed\n",
        "regression.txt": "test evidence\n",
    }
    assert (
        check_workspace_patch_applies_to_fresh_baseline(snapshot, result.patch_diff)
        is None
    )
    assert (tmp_path / "artifacts/workspace.patch").read_text() == result.patch_diff
