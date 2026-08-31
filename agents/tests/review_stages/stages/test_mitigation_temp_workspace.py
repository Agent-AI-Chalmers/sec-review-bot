import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.review_stages.mitigation.stage import (
    create_skipped_mitigation_result,
    run_mitigation_stage,
)
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
    baseline_snapshot_tar_path: Path,
) -> list[Path]:
    captured_workspace_paths: list[Path] = []

    def build_backend(workspace_path: Path) -> object:
        assert (workspace_path / "src" / "app.js").exists()
        captured_workspace_paths.append(workspace_path)
        return object()

    async def create_agent_graph(**_kwargs: Any) -> object:
        return object()

    async def invoke_agent_graph(**_kwargs: Any) -> dict[str, Any]:
        return {
            "overview": "No changes needed.",
            "declared_changed_files": [],
        }

    with (
        patch(
            "sec_review_agents.review_stages.mitigation.stage.create_mitigation_agent_graph",
            side_effect=create_agent_graph,
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.invoke_agent_runtime_graph",
            side_effect=invoke_agent_graph,
        ),
        patch(
            "sec_review_agents.review_stages.mitigation.stage.persist_workspace_patch",
            return_value={
                "changed_files": [],
                "file_changes": [],
                "patch_diff": "",
            },
        ),
    ):
        await run_mitigation_stage(
            agent_name="mitigator",
            mitigator_artifacts_path=tmp_path / "artifacts" / "mitigator",
            baseline_snapshot_tar_path=baseline_snapshot_tar_path,
            retry_context=None,
            build_backend=build_backend,
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
        baseline_snapshot_tar_path=local_root / WORKSPACE_SNAPSHOT_TAR_NAME,
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
            baseline_snapshot_tar_path=Path(materialization["local_root_path"])
            / WORKSPACE_SNAPSHOT_TAR_NAME,
        )


def test_create_skipped_mitigation_result_persists_empty_patch_without_temp_workspace(
    tmp_path: Path,
) -> None:
    materialization = _build_base_materialization(tmp_path)
    local_root = Path(materialization["local_root_path"])
    run_artifacts = local_root / "artifacts"
    mitigator_artifacts = run_artifacts / "mitigator"
    _add_snapshot_seed(materialization)

    result = create_skipped_mitigation_result(
        mitigator_artifacts_path=mitigator_artifacts,
        retry_context=None,
        reason="No mitigation target",
    )

    patch_path = mitigator_artifacts / "workspace.patch"
    assert patch_path.exists()
    assert patch_path.read_text(encoding="utf-8") == ""

    tmp_root = run_artifacts / "tmp-workspaces" / "mitigation"
    assert not tmp_root.exists()

    assert "change_status" not in result
