from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.filesystem.backend_factory import BackendConfig
from sec_review_agents.review_stages.verification.stage import run_verification_stage


def _verification_payload(*, patch_coverage: str = "full") -> dict[str, Any]:
    return {
        "overview": "Patch fully covers the target claim.",
        "review_target_claim": "target claim",
        "patch_coverage": patch_coverage,
        "resolution_next_step": "none",
        "validation_level": "static",
        "regression_status": "not-run",
        "patch_findings": [],
        "verification_findings": ["ok"],
        "residual_risks": [],
    }


@pytest.mark.asyncio
async def test_run_verification_stage_prepares_workspace_before_backend() -> None:
    call_order: list[str] = []

    def _restore_workspace(**kwargs: Any) -> Path:
        call_order.append("restore")
        assert kwargs["tar_path"] == Path("/tmp/workspace.snapshot.tar")
        return kwargs["destination_path"]

    def _apply_workspace_patch(**kwargs: Any) -> None:
        call_order.append("apply")
        assert kwargs["workspace_patch"] == "diff --git a/a b/a\n"

    def _build_backend(workspace_root: Path) -> BackendConfig:
        call_order.append("backend")
        assert workspace_root.name.startswith("sec-review-verifier-")
        return BackendConfig(
            container_name_prefix="test",
            path_views=[],
            image=None,
            backend_kind="local",
        )

    async def _run_agent(**_kwargs: Any) -> dict[str, Any]:
        call_order.append("invoke")
        return _verification_payload()

    with (
        patch(
            "sec_review_agents.review_stages.verification.stage.restore_workspace_from_snapshot_tar",
            side_effect=_restore_workspace,
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage._apply_workspace_patch",
            side_effect=_apply_workspace_patch,
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage.run_verification_agent",
            side_effect=_run_agent,
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage.persist_verification_result"
        ),
    ):
        result = await run_verification_stage(
            agent_name="verification-agent",
            verifier_artifacts_path=Path("/tmp/verifier"),
            attempt_label="initial",
            baseline_snapshot_tar_path=Path("/tmp/workspace.snapshot.tar"),
            workspace_patch="diff --git a/a b/a\n",
            mitigation_result={"changed_files": []},
            build_backend_config=_build_backend,
            system_prompt="base prompt",
            filesystem_system_prompt="filesystem prompt",
            user_prompt="user prompt",
        )

    assert call_order == ["restore", "apply", "backend", "invoke"]
    assert result["patch_coverage"] == "full"


@pytest.mark.asyncio
async def test_run_verification_stage_uses_unpatched_workspace_when_no_patch() -> None:
    captured_workspace_roots: list[Path] = []

    def _build_backend(workspace_root: Path) -> BackendConfig:
        captured_workspace_roots.append(workspace_root)
        return BackendConfig(
            container_name_prefix="test",
            path_views=[],
            image=None,
            backend_kind="local",
        )

    with (
        patch(
            "sec_review_agents.review_stages.verification.stage.restore_workspace_from_snapshot_tar",
            side_effect=lambda **kwargs: kwargs["destination_path"],
        ),
        patch(
            "sec_review_agents.review_stages.verification.stage._apply_workspace_patch",
        ) as apply_workspace_patch_mock,
        patch(
            "sec_review_agents.review_stages.verification.stage.run_verification_agent",
            return_value=_verification_payload(patch_coverage="no-patch"),
        ) as agent_mock,
        patch(
            "sec_review_agents.review_stages.verification.stage.persist_verification_result"
        ),
    ):
        result = await run_verification_stage(
            agent_name="verification-agent",
            verifier_artifacts_path=Path("/tmp/verifier"),
            attempt_label="initial",
            baseline_snapshot_tar_path=Path("/tmp/workspace.snapshot.tar"),
            workspace_patch=None,
            mitigation_result={"changed_files": []},
            build_backend_config=_build_backend,
            system_prompt="base prompt",
            filesystem_system_prompt="filesystem prompt",
            user_prompt="user prompt",
        )

    apply_workspace_patch_mock.assert_called_once()
    assert apply_workspace_patch_mock.call_args.kwargs["workspace_patch"] is None
    agent_mock.assert_called_once()
    assert len(captured_workspace_roots) == 1
    assert captured_workspace_roots[0].name.startswith("sec-review-verifier-")
    assert result["patch_coverage"] == "no-patch"
