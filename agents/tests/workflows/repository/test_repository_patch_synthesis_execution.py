import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.agents.patch_synthesis.model import PatchSynthesisOutput
from sec_review_agents.delivery_stages.execution.input import DeliveryPatchCase
from sec_review_agents.delivery_stages.model import (
    DeliveryEntry,
    DeliveryPlan,
    DeliveryPlanningCounts,
    DeliveryPlanningMetadata,
)
from sec_review_agents.utils.files import persist_text_artifact
from sec_review_agents.workflows.prepared_input import PreparedRepositoryInput
from sec_review_agents.workflows.repository import direct as repository_direct
from sec_review_agents.workflows.repository.workflow import (
    plan_repository_delivery_activity,
    prepare_repository_delivery_execution_activity,
)
from sec_review_agents.workflows.repository_case.result import RepositoryCaseResult
from sec_review_agents.workflows.review_request import ReviewWorkflowRequest
from sec_review_agents.workspace.commits import (
    build_committed_patch,
    resolve_workspace_commit,
)
from sec_review_agents.workspace.file_changes import (
    FileChange,
    file_change_paths,
)
from sec_review_agents.workspace.patches import (
    PatchArtifact,
)
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar
from tests.prepared_input_fixtures import prepared_repository_input


def _build_file_changes_from_workspace_patch(
    *,
    source_workspace_path: Path,
    patch_path: Path | str | None,
) -> list[FileChange]:
    if patch_path is None:
        return []
    patch_path = Path(patch_path)
    if not patch_path.exists():
        return []
    patch_content = patch_path.read_text(encoding="utf-8")
    if not patch_content.strip():
        return []

    with tempfile.TemporaryDirectory() as tempdir:
        patched_workspace_path = Path(tempdir) / "workspace"
        shutil.copytree(source_workspace_path, patched_workspace_path, symlinks=True)
        baseline_commit = resolve_workspace_commit(patched_workspace_path)
        process = subprocess.run(
            ["git", "apply", "-p1", str(patch_path)],
            cwd=patched_workspace_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if process.returncode != 0:
            raise RuntimeError(
                process.stderr.strip()
                or process.stdout.strip()
                or f"Failed to apply test patch {patch_path}."
            )
        subprocess.run(
            ["git", "add", "-A"],
            cwd=patched_workspace_path,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-qm", "fixture patch"],
            cwd=patched_workspace_path,
            check=True,
            capture_output=True,
        )
        return build_committed_patch(
            patched_workspace_path, baseline_commit=baseline_commit
        ).file_changes


async def _execute_delivery_direct_for_test(
    *,
    input_data: PreparedRepositoryInput,
    keep_case_results: list[dict],
    delivery_plan: DeliveryPlan,
) -> dict[str, Any]:
    workspace_path = Path(input_data.input_bundle_root_path) / "workspace"
    if workspace_path.is_dir():
        create_workspace_snapshot_tar(
            workspace_path=workspace_path,
            tar_path=Path(input_data.workspace_snapshot_tar_path),
        )
    request = ReviewWorkflowRequest(
        workflow="repository-review",
        run_id="delivery-execution-test",
        prepared_input=input_data,
        timeout_seconds=30,
        runtime_context={},
    )
    with patch.object(
        repository_direct,
        "plan_repository_delivery_activity",
        return_value=delivery_plan,
    ):
        result = await repository_direct.run_repository_delivery_direct(
            request,
            [RepositoryCaseResult.model_validate(item) for item in keep_case_results],
        )
        return result.model_dump(mode="json")


async def _run_repository_delivery_workflow_steps_for_test(
    *,
    input_data: PreparedRepositoryInput,
    case_results: list[dict],
) -> dict[str, Any]:
    request = ReviewWorkflowRequest(
        workflow="repository-review",
        run_id="delivery-execution-test",
        prepared_input=input_data,
        timeout_seconds=60,
        runtime_context={},
    )
    delivery_plan = await plan_repository_delivery_activity(
        request,
        [RepositoryCaseResult.model_validate(item) for item in case_results],
    )
    with patch.object(
        repository_direct,
        "plan_repository_delivery_activity",
        side_effect=lambda *args, **kwargs: delivery_plan,
    ):
        result = await repository_direct.run_repository_delivery_direct(
            request,
            [RepositoryCaseResult.model_validate(item) for item in case_results],
        )
        return result.model_dump(mode="json")


class TestRepositoryDeliveryExecution:
    def setup_method(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.local_root = self.root / "local"
        self.workspace_root = self.local_root / "workspace"
        self.run_id = "run-test"
        self.run_artifacts = self.local_root / "artifacts"
        self.case_artifacts = self.run_artifacts / "cases"
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.case_artifacts.mkdir(parents=True, exist_ok=True)

        self.input_data = prepared_repository_input(
            input_bundle_root_path=str(self.local_root),
            artifact_root_path=str(self.run_artifacts),
            cases_artifacts_path=str(self.case_artifacts),
            workspace_snapshot_tar_path=str(self.local_root / "workspace.snapshot.tar"),
        )

    def teardown_method(self) -> None:
        self.tempdir.cleanup()

    def _write_workspace(self, files: dict[str, str]) -> None:
        shutil.rmtree(self.workspace_root, ignore_errors=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        for relative_path, content in files.items():
            absolute_path = self.workspace_root / relative_path
            absolute_path.parent.mkdir(parents=True, exist_ok=True)
            absolute_path.write_text(content, encoding="utf-8")

    def _use_deterministic_combined_patch_outcomes(self):
        def _synthesize_combined_delivery_patch(
            *,
            workspace_snapshot_tar_path: Path,
            patch_synthesis_root: Path,
            delivery_entry: dict,
            case_items: list[DeliveryPatchCase],
        ) -> PatchArtifact:
            changed_files = [
                path
                for case_item in case_items
                for path in file_change_paths(case_item.mitigator_file_changes)
            ]
            file_changes = [
                {
                    "path": path,
                    "status": "upsert",
                    "content": "deterministic combined content\n",
                    "content_encoding": "utf-8",
                }
                for path in changed_files
            ]
            return PatchArtifact.model_validate(
                {
                    "patch_diff": "",
                    "file_changes": file_changes,
                }
            )

        return patch(
            "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
            side_effect=_synthesize_combined_delivery_patch,
        )

    def _init_git_repo(self, workspace_root: Path) -> None:
        subprocess.run(
            ["git", "init"],
            cwd=workspace_root,
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "sec-review-agents"],
            cwd=workspace_root,
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "sec-review-agents@localhost"],
            cwd=workspace_root,
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "add", "--all", "."],
            cwd=workspace_root,
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "commit", "--allow-empty", "-m", "baseline"],
            cwd=workspace_root,
            check=True,
            capture_output=True,
            text=True,
        )

    def _init_workspace_git_repo(self) -> None:
        self._init_git_repo(self.workspace_root)

    def _prepare_case_patch(self, case_id: str, mutate_workspace) -> dict:
        if not (self.workspace_root / ".git").exists():
            self._init_workspace_git_repo()
        case_local_root = self.root / f"{case_id}-local"
        case_workspace_root = case_local_root / "workspace"
        shutil.rmtree(case_local_root, ignore_errors=True)
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(case_workspace_root), "HEAD"],
            cwd=self.workspace_root,
            check=True,
            capture_output=True,
            text=True,
        )
        mutate_workspace(case_workspace_root)

        baseline_commit = resolve_workspace_commit(case_workspace_root)
        subprocess.run(
            ["git", "add", "-A"],
            cwd=case_workspace_root,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "--allow-empty", "-qm", "case repair"],
            cwd=case_workspace_root,
            check=True,
            capture_output=True,
        )
        patch_artifact = build_committed_patch(
            case_workspace_root, baseline_commit=baseline_commit
        ).model_dump(mode="json")
        patch_path = persist_text_artifact(
            self.case_artifacts / case_id / "mitigator",
            "workspace.patch",
            patch_artifact["patch_diff"],
        )
        return {**patch_artifact, "patch_path": str(patch_path)}

    def _case_result(
        self,
        case_id: str,
        *,
        patch_coverage: str = "full",
    ) -> dict:
        analysis = {
            "verdict": "confirmed-defect",
            "overview": f"Analyzer overview for {case_id}.",
            "residual_risks": [],
        }
        patch_path = self.case_artifacts / case_id / "mitigator" / "workspace.patch"
        patch_diff = (
            patch_path.read_text(encoding="utf-8") if patch_path.exists() else None
        )
        file_changes = (
            _build_file_changes_from_workspace_patch(
                source_workspace_path=self.workspace_root,
                patch_path=patch_path,
            )
            if patch_diff
            else []
        )
        mitigation = {
            "overview": f"Mitigation overview for {case_id}.",
            "file_changes": file_changes,
            "patch_diff": patch_diff,
            "residual_risks": [],
        }
        verification = {
            "overview": f"Verifier overview for {case_id}.",
            "patch_coverage": patch_coverage,
            "patch_findings": [] if patch_coverage == "full" else ["needs revision"],
            "verification_findings": [],
            "residual_risks": [],
        }
        return {
            "case_id": case_id,
            "review_record": {
                "strategy": {
                    "name": "default",
                    "stages": ["analysis", "cvss", "mitigation", "verification"],
                },
                "analysis": analysis,
                "mitigation": mitigation,
                "verification": verification,
                "cvss": None,
            },
            "disposition": "keep",
            "reason": "Ready for delivery execution.",
        }

    def _delivery_agent_response(
        self, workspace: Path, paths: list[str]
    ) -> PatchSynthesisOutput:
        subprocess.run(
            ["git", "add", "--", *paths], cwd=workspace, check=True, capture_output=True
        )
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "commit",
                "--allow-empty",
                "-m",
                "combined repair",
            ],
            cwd=workspace,
            check=True,
            capture_output=True,
        )
        return PatchSynthesisOutput(overview="Combined repair committed.")

    def _latest_patch_synthesis_workspace(self, calls: list[dict]) -> Path:
        assert calls
        return Path(calls[-1]["workspace_root_path"])

    def _delivery_plan(self, deliveries: list[dict] | None = None) -> DeliveryPlan:
        raw_deliveries = (
            deliveries
            if deliveries is not None
            else [
                {
                    "strategy": "single",
                    "case_ids": ["case-1"],
                }
            ]
        )
        ordered_case_ids = [
            case_id
            for delivery in raw_deliveries
            for case_id in delivery.get("case_ids", [])
            if isinstance(case_id, str)
        ]
        workbench_state = DeliveryWorkbenchState.initial(ordered_case_ids)
        for delivery in raw_deliveries:
            kind = delivery.get("kind")
            reason = delivery.get("reason")
            workbench_state.create_group(
                kind=kind if isinstance(kind, str) else None,
                reason=reason if isinstance(reason, str) else None,
                item_ids=[
                    case_id
                    for case_id in delivery.get("case_ids", [])
                    if isinstance(case_id, str)
                ],
            )
        return DeliveryPlan(
            status="completed",
            metadata=DeliveryPlanningMetadata(
                planning_mode="single", planning_pass_count=1, batch_size=None
            ),
            counts=DeliveryPlanningCounts(input_case_count=0, delivery_count=0),
            deliveries=workbench_state.export_deliveries(),
        )

    def _artifact_path(self, delivery_id: str) -> Path:
        return (
            self.run_artifacts
            / "delivery-execution"
            / "artifacts"
            / f"{delivery_id}.json"
        )

    def _read_artifact(self, delivery_id: str) -> dict:
        return json.loads(self._artifact_path(delivery_id).read_text(encoding="utf-8"))

    @pytest.mark.asyncio
    async def test_temporal_delivery_execution_input_uses_compact_case_views(
        self,
    ) -> None:
        case_one = self._case_result("case-1")
        case_two = self._case_result("case-2")
        case_one["review_record"]["mitigation"]["patch_diff"] = "single diff"
        case_two["review_record"]["mitigation"]["patch_diff"] = "combined diff"
        case_one["review_record"]["mitigation"]["file_changes"] = [
            {
                "path": "src/single.py",
                "status": "upsert",
                "content": "single content",
                "content_encoding": "utf-8",
            }
        ]
        case_two["review_record"]["mitigation"]["file_changes"] = [
            {
                "path": "src/combined.py",
                "status": "upsert",
                "content": "combined content",
                "content_encoding": "utf-8",
            }
        ]
        delivery_plan = DeliveryPlan(
            status="completed",
            metadata=DeliveryPlanningMetadata(
                planning_mode="single", planning_pass_count=1, batch_size=None
            ),
            counts=DeliveryPlanningCounts(input_case_count=0, delivery_count=0),
            deliveries=[
                DeliveryEntry(
                    delivery_id="delivery-single",
                    strategy="single",
                    case_ids=["case-1"],
                    reason="single delivery",
                ),
                DeliveryEntry(
                    delivery_id="delivery-combined",
                    strategy="combined",
                    case_ids=["case-2"],
                    reason="combined delivery",
                ),
            ],
        )
        request = ReviewWorkflowRequest(
            workflow="repository-review",
            run_id=self.run_id,
            prepared_input=self.input_data,
            timeout_seconds=60,
            runtime_context={},
        )

        delivery_execution_input = prepare_repository_delivery_execution_activity(
            request,
            [
                RepositoryCaseResult.model_validate(item)
                for item in [case_one, case_two]
            ],
            DeliveryPlan(
                status="completed",
                metadata=DeliveryPlanningMetadata(
                    planning_mode="single", planning_pass_count=1, batch_size=None
                ),
                counts=DeliveryPlanningCounts(input_case_count=0, delivery_count=0),
                deliveries=delivery_plan.deliveries,
            ),
        )

        assert delivery_execution_input.keep_case_ids == ["case-1", "case-2"]
        assert "cases_artifacts_root_path" not in delivery_execution_input.model_dump()
        single_case = delivery_execution_input.single_delivery_execution_items[
            0
        ].case_items[0]
        assert single_case.mitigator_file_changes == [
            {
                "path": "src/single.py",
                "status": "upsert",
                "content": "single content",
                "content_encoding": "utf-8",
            }
        ]
        combined_case = delivery_execution_input.combined_delivery_execution_items[
            0
        ].case_items[0]
        assert combined_case.mitigator_file_changes == [
            {
                "path": "src/combined.py",
                "status": "upsert",
                "content": "combined content",
                "content_encoding": "utf-8",
            }
        ]
        assert combined_case.mitigator_patch_diff == "combined diff"

    @pytest.mark.asyncio
    async def test_single_case_publishable_modify(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
                "src/keep.txt": "keep\n",
            }
        )
        self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1")

        result = await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[case_result],
            delivery_plan=self._delivery_plan(),
        )

        artifact = self._read_artifact("case-1")
        assert result["deliveries"][0] == artifact
        assert "changed_files" not in artifact
        assert [item["path"] for item in artifact["file_changes"]] == ["src/app.txt"]
        assert "cases" not in artifact
        assert artifact["case_ids"] == ["case-1"]
        assert artifact["file_changes"] == [
            {
                "path": "src/app.txt",
                "status": "upsert",
                "mode": "100644",
                "content": "alpha updated\n",
                "content_encoding": "utf-8",
            }
        ]

    def test_build_file_changes_from_workspace_patch_rejects_unsafe_paths(
        self,
    ) -> None:
        self._write_workspace({"safe.txt": "safe\n"})
        patch_path = self.root / "unsafe.patch"
        patch_path.write_text(
            (
                "diff --git a/../escape.txt b/../escape.txt\n"
                "new file mode 100644\n"
                "index 0000000..e69de29\n"
                "--- /dev/null\n"
                "+++ b/../escape.txt\n"
            ),
            encoding="utf-8",
        )

        with pytest.raises(RuntimeError):
            _build_file_changes_from_workspace_patch(
                source_workspace_path=self.workspace_root,
                patch_path=patch_path,
            )

    @pytest.mark.asyncio
    async def test_single_case_publishable_delete(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
                "src/remove.txt": "delete me\n",
            }
        )
        self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/remove.txt").unlink(),
        )
        case_result = self._case_result("case-1")

        await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[case_result],
            delivery_plan=self._delivery_plan(),
        )

        artifact = self._read_artifact("case-1")
        assert "changed_files" not in artifact
        assert artifact["file_changes"] == [
            {
                "path": "src/remove.txt",
                "status": "deleted",
            }
        ]

    @pytest.mark.asyncio
    async def test_single_case_delivery_artifact_uses_file_changes_without_patch_path(
        self,
    ) -> None:
        case_result = self._case_result("case-1")
        case_result["review_record"]["mitigation"]["patch_diff"] = None
        case_result["review_record"]["mitigation"]["file_changes"] = [
            {
                "path": "src/app.txt",
                "status": "upsert",
                "content": "alpha updated\n",
                "content_encoding": "utf-8",
            }
        ]

        await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[case_result],
            delivery_plan=self._delivery_plan(),
        )

        artifact = self._read_artifact("case-1")
        assert artifact["file_changes"] == [
            {
                "path": "src/app.txt",
                "status": "upsert",
                "content": "alpha updated\n",
                "content_encoding": "utf-8",
            }
        ]

    @pytest.mark.asyncio
    async def test_single_case_delivery_artifact_does_not_require_source_workspace(
        self,
    ) -> None:
        shutil.rmtree(self.workspace_root, ignore_errors=True)
        case_result = self._case_result("case-1")
        case_result["review_record"]["mitigation"]["patch_diff"] = None
        case_result["review_record"]["mitigation"]["file_changes"] = [
            {
                "path": "src/app.txt",
                "status": "upsert",
                "content": "alpha updated\n",
                "content_encoding": "utf-8",
            }
        ]

        await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[case_result],
            delivery_plan=self._delivery_plan(),
        )

        artifact = self._read_artifact("case-1")
        assert [item["path"] for item in artifact["file_changes"]] == ["src/app.txt"]

    @pytest.mark.asyncio
    async def test_delivery_execution_uses_system_delivery_ids(self) -> None:
        self._write_workspace({"src/app.txt": "old\n"})
        self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "new\n", encoding="utf-8"
            ),
        )

        result = await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[
                self._case_result("case-1"),
            ],
            delivery_plan=self._delivery_plan(
                [
                    {
                        "strategy": "single",
                        "case_ids": ["case-1"],
                    }
                ]
            ),
        )

        assert result["deliveries"][0]["delivery_id"] == "case-1"
        assert self._artifact_path("case-1").exists()

    @pytest.mark.asyncio
    async def test_combined_delivery_agent_synthesis_publishable(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "value=1\n",
            }
        )
        patch_one = self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=2\n", encoding="utf-8"
            ),
        )
        patch_two = self._prepare_case_patch(
            "case-two",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=3\n", encoding="utf-8"
            ),
        )
        case_results = [
            self._case_result("case-one"),
            self._case_result("case-two"),
        ]
        Path(patch_one["patch_path"]).unlink()
        Path(patch_two["patch_path"]).unlink()

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            create_agent_calls.append(kwargs)
            invoke_calls["count"] += 1
            for trajectory_path in kwargs["trajectory_paths"]:
                trajectory_path.parent.mkdir(parents=True, exist_ok=True)
                trajectory_path.write_text("{}\n", encoding="utf-8")
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/app.txt").write_text(
                    "value=3\n", encoding="utf-8"
                )
            return self._delivery_agent_response(
                Path(kwargs["workspace_root_path"]), ["src/app.txt"]
            )

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-one", "case-two"],
                        },
                    ]
                ),
            )

        artifact = self._read_artifact("combined-edb095e4e7")
        assert artifact["file_changes"] == [
            {
                "path": "src/app.txt",
                "status": "upsert",
                "mode": "100644",
                "content": "value=3\n",
                "content_encoding": "utf-8",
            }
        ]
        assert len(create_agent_calls) == 1
        assert "response_format" not in create_agent_calls[0]
        patch_synthesis_artifacts = (
            self.run_artifacts / "patch-synthesis" / "combined-edb095e4e7"
        )
        assert (patch_synthesis_artifacts / "trajectory.jsonl").exists()
        assert (patch_synthesis_artifacts / "workspace.patch").exists()

    @pytest.mark.asyncio
    async def test_delivery_agent_records_scope_expansion(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "value=1\n",
            }
        )
        self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=2\n", encoding="utf-8"
            ),
        )
        self._prepare_case_patch(
            "case-two",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=3\n", encoding="utf-8"
            ),
        )
        case_results = [
            self._case_result("case-one"),
            self._case_result("case-two"),
        ]

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            create_agent_calls.append(kwargs)
            invoke_calls["count"] += 1
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/other.txt").write_text(
                    "boom\n", encoding="utf-8"
                )
            return self._delivery_agent_response(
                Path(kwargs["workspace_root_path"]), ["src/other.txt"]
            )

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-one", "case-two"],
                        },
                    ]
                ),
            )

        artifact = self._read_artifact("combined-edb095e4e7")
        assert [item["path"] for item in artifact["file_changes"]] == ["src/other.txt"]
        assert "changed_files" not in artifact

    @pytest.mark.asyncio
    async def test_delivery_agent_excludes_unreported_workspace_side_effects(
        self,
    ) -> None:
        self._write_workspace(
            {
                "src/app.txt": "value=1\n",
            }
        )
        self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=2\n", encoding="utf-8"
            ),
        )
        self._prepare_case_patch(
            "case-two",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=3\n", encoding="utf-8"
            ),
        )
        case_results = [
            self._case_result("case-one"),
            self._case_result("case-two"),
        ]

        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            create_agent_calls.append(kwargs)
            merge_workspace = self._latest_patch_synthesis_workspace(create_agent_calls)
            (merge_workspace / "src/app.txt").write_text("value=3\n", encoding="utf-8")
            (merge_workspace / "dist").mkdir(parents=True, exist_ok=True)
            (merge_workspace / "dist/bundle.js").write_text(
                "generated\n", encoding="utf-8"
            )
            return self._delivery_agent_response(
                Path(kwargs["workspace_root_path"]), ["src/app.txt"]
            )

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-one", "case-two"],
                        },
                    ]
                ),
            )

        artifact = self._read_artifact("combined-edb095e4e7")
        assert [item["path"] for item in artifact["file_changes"]] == ["src/app.txt"]
        assert "changed_files" not in artifact

    @pytest.mark.asyncio
    async def test_delivery_agent_empty_result_blocks_combined_delivery(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "value=1\n",
            }
        )
        self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=2\n", encoding="utf-8"
            ),
        )
        self._prepare_case_patch(
            "case-two",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=3\n", encoding="utf-8"
            ),
        )
        case_results = [
            self._case_result("case-one"),
            self._case_result("case-two"),
        ]

        invoke_calls = {"count": 0}

        def _invoke_side_effect(*args, **kwargs):
            invoke_calls["count"] += 1
            return {}

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            result = await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-one", "case-two"],
                        },
                    ]
                ),
            )

        assert not self._artifact_path("combined-edb095e4e7").exists()
        assert result["deliveries"] == []
        assert invoke_calls["count"] == 1

    @pytest.mark.asyncio
    async def test_delivery_agent_uses_workspace_diff_not_reported_paths(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "value=1\n",
            }
        )
        self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=2\n", encoding="utf-8"
            ),
        )
        self._prepare_case_patch(
            "case-two",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "value=3\n", encoding="utf-8"
            ),
        )
        case_results = [
            self._case_result("case-one"),
            self._case_result("case-two"),
        ]

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            create_agent_calls.append(kwargs)
            invoke_calls["count"] += 1
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/app.txt").write_text(
                    "value=3\n", encoding="utf-8"
                )
                return self._delivery_agent_response(
                    Path(kwargs["workspace_root_path"]), ["workspace/src/app.txt"]
                )
            return self._delivery_agent_response(
                Path(kwargs["workspace_root_path"]), ["workspace/src/app.txt"]
            )

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-one", "case-two"],
                        },
                    ]
                ),
            )

    @pytest.mark.asyncio
    async def test_delivery_agent_input_uses_reference_patches_and_overlap_summary(
        self,
    ) -> None:
        large_content = "\n".join([f"line-{index}" for index in range(2000)]) + "\n"
        self._write_workspace(
            {
                "package-lock.json": large_content,
            }
        )
        self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "package-lock.json").write_text(
                large_content.replace("line-1000", "line-case-one"),
                encoding="utf-8",
            ),
        )
        self._prepare_case_patch(
            "case-two",
            lambda workspace: (workspace / "package-lock.json").write_text(
                large_content.replace("line-1000", "line-case-two"),
                encoding="utf-8",
            ),
        )
        case_results = [
            self._case_result("case-one"),
            self._case_result("case-two"),
        ]

        invoke_calls = {"count": 0}
        invoke_user_prompts: list[str] = []
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            create_agent_calls.append(kwargs)
            invoke_calls["count"] += 1
            invoke_user_prompts.append(kwargs["user_prompt"])
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "package-lock.json").write_text(
                    large_content.replace("line-1000", "line-case-two"),
                    encoding="utf-8",
                )
            return self._delivery_agent_response(
                Path(kwargs["workspace_root_path"]), ["package-lock.json"]
            )

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-one", "case-two"],
                        },
                    ]
                ),
            )

        assert invoke_user_prompts
        patch_synthesis_brief = invoke_user_prompts[-1]
        assert "## File Hints" not in patch_synthesis_brief
        assert "## Overlapping Case Files" in patch_synthesis_brief
        assert "`package-lock.json`: `case-one`, `case-two`" in patch_synthesis_brief
        assert "### `case-one`\n\n- Changed files:" in patch_synthesis_brief
        assert "### `case-two`\n\n- Changed files:" in patch_synthesis_brief
        assert "Case Label:" not in patch_synthesis_brief
        assert "#### Reference Patch" in patch_synthesis_brief
        assert "```diff" in patch_synthesis_brief
        assert "line-case-one" in patch_synthesis_brief
        assert "line-case-two" in patch_synthesis_brief
        assert "Patch unavailable." not in patch_synthesis_brief
        first_patch_block = patch_synthesis_brief.split("```diff\n", 1)[1].split(
            "\n```", 1
        )[0]
        assert not first_patch_block.endswith("\n")
        assert "- Source artifact:" not in patch_synthesis_brief
        assert "- Verifier coverage:" not in patch_synthesis_brief
        assert "- Analyzer verdict:" not in patch_synthesis_brief
        assert "- Analyzer overview:" not in patch_synthesis_brief
        assert "- Verifier overview:" not in patch_synthesis_brief
        assert "## Instructions" not in patch_synthesis_brief

    @pytest.mark.asyncio
    async def test_delivery_agent_preserves_non_conflict_case_changes(self) -> None:
        self._write_workspace(
            {
                "src/a.txt": "A0\n",
                "src/b.txt": "B0\n",
            }
        )

        self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "src/a.txt").write_text(
                "A1\n", encoding="utf-8"
            ),
        )

        def _mutate_case_two(workspace: Path) -> None:
            (workspace / "src/a.txt").write_text("A2\n", encoding="utf-8")
            (workspace / "src/b.txt").write_text("B2\n", encoding="utf-8")

        self._prepare_case_patch("case-two", _mutate_case_two)
        case_results = [
            self._case_result("case-one"),
            self._case_result("case-two"),
        ]

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            create_agent_calls.append(kwargs)
            invoke_calls["count"] += 1
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/a.txt").write_text("A2\n", encoding="utf-8")
                (merge_workspace / "src/b.txt").write_text("B2\n", encoding="utf-8")
            return self._delivery_agent_response(
                Path(kwargs["workspace_root_path"]), ["src/a.txt", "src/b.txt"]
            )

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-one", "case-two"],
                        },
                    ]
                ),
            )

        artifact = self._read_artifact("combined-edb095e4e7")
        snapshots_by_path = {item["path"]: item for item in artifact["file_changes"]}
        assert set(snapshots_by_path) == {"src/a.txt", "src/b.txt"}
        assert snapshots_by_path["src/a.txt"]["content"] == "A2\n"
        assert snapshots_by_path["src/b.txt"]["content"] == "B2\n"

    @pytest.mark.asyncio
    async def test_single_case_delivery_uses_file_changes_when_source_workspace_is_missing(
        self,
    ) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
            }
        )
        self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1")

        shutil.rmtree(self.workspace_root, ignore_errors=True)

        result = await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[case_result],
            delivery_plan=self._delivery_plan(),
        )

        assert len(result["deliveries"]) == 1
        artifact = self._read_artifact("case-1")
        assert result["deliveries"][0] == artifact
        assert [item["path"] for item in artifact["file_changes"]] == ["src/app.txt"]

    @pytest.mark.asyncio
    async def test_delivery_artifact_does_not_publish_delivery_residual_risks(
        self,
    ) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
            }
        )
        self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1")
        case_result["review_record"]["verification"]["residual_risks"] = [
            "raw-verifier-risk"
        ]

        await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[case_result],
            delivery_plan=self._delivery_plan(
                [
                    {
                        "strategy": "single",
                        "case_ids": ["case-1"],
                    },
                ]
            ),
        )

        artifact = self._read_artifact("case-1")
        assert "residual_risks" not in artifact
        assert "cases" not in artifact
        assert artifact["case_ids"] == ["case-1"]

    @pytest.mark.asyncio
    async def test_executor_uses_planner_single_delivery_id_without_agent(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
            }
        )
        self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1")

        with patch(
            "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent"
        ) as create_graph:
            result = await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=[case_result],
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "single",
                            "case_ids": ["case-1"],
                        },
                    ]
                ),
            )

        assert result["deliveries"][0]["delivery_id"] == "case-1"
        create_graph.assert_not_called()

    @pytest.mark.asyncio
    async def test_executor_rejects_unknown_delivery_strategy(self) -> None:
        self._write_workspace({"src/app.txt": "alpha\n"})
        case_result = self._case_result("case-1")

        with pytest.raises(ValueError, match="strategy"):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=[case_result],
                delivery_plan=DeliveryPlan(
                    status="completed",
                    metadata=DeliveryPlanningMetadata(
                        planning_mode="single", planning_pass_count=1, batch_size=None
                    ),
                    counts=DeliveryPlanningCounts(input_case_count=0, delivery_count=0),
                    deliveries=[
                        DeliveryEntry(
                            delivery_id="delivery-invalid",
                            strategy="legacy",  # type: ignore[arg-type]
                            case_ids=["case-1"],
                            reason="bad strategy",
                        )
                    ],
                ),
            )

    @pytest.mark.asyncio
    async def test_delivery_stage_skips_planning_when_no_cases_are_kept(self) -> None:
        blocked_case = self._case_result("case-1")
        blocked_case["disposition"] = "blocked"
        blocked_case["reason"] = "Case is not ready for delivery."
        with (
            patch(
                "sec_review_agents.delivery_stages.planning.stage.generate_delivery_plan",
            ) as planner_mock,
            patch(
                "sec_review_agents.delivery_stages.execution.input.build_delivery_execution_input",
            ) as execution_input_mock,
        ):
            execution_result = await _run_repository_delivery_workflow_steps_for_test(
                input_data=self.input_data,
                case_results=[blocked_case],
            )

        planner_mock.assert_not_called()
        execution_input_mock.assert_not_called()
        plan_result = json.loads(
            (self.run_artifacts / "delivery-planning" / "delivery-plan.json").read_text(
                encoding="utf-8"
            )
        )
        assert plan_result["status"] == "skipped"
        assert plan_result["deliveries"] == []
        assert plan_result["metadata"] == {
            "planning_mode": "skipped",
            "planning_pass_count": 0,
            "batch_size": None,
        }
        assert plan_result["counts"] == {
            "input_case_count": 0,
            "delivery_count": 0,
            "total_case_count": 1,
        }
        assert execution_result["status"] == "skipped"
        assert execution_result["deliveries"] == []
        persisted_result = json.loads(
            (
                self.run_artifacts / "delivery-execution" / "delivery-result.json"
            ).read_text(encoding="utf-8")
        )
        assert persisted_result == execution_result

    @pytest.mark.asyncio
    async def test_delivery_artifact_omits_planner_notes(self) -> None:
        self._write_workspace(
            {
                "src/a.txt": "alpha\n",
                "src/b.txt": "bravo\n",
            }
        )
        self._prepare_case_patch(
            "case-a",
            lambda workspace: (workspace / "src/a.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        self._prepare_case_patch(
            "case-b",
            lambda workspace: (workspace / "src/b.txt").write_text(
                "bravo updated\n", encoding="utf-8"
            ),
        )
        case_results = [
            self._case_result("case-a"),
            self._case_result("case-b"),
        ]

        with self._use_deterministic_combined_patch_outcomes():
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-a", "case-b"],
                        }
                    ]
                ),
            )

        artifact = self._read_artifact("combined-b674cd56f5")
        assert "residual_risks" not in artifact

    @pytest.mark.asyncio
    async def test_combined_delivery_patch_failure_does_not_block_other_deliveries(
        self,
    ) -> None:
        """Keep independent planned deliveries publishable after a sibling fails."""
        self._write_workspace(
            {
                "src/a.txt": "alpha\n",
                "src/b.txt": "bravo\n",
                "src/c.txt": "charlie\n",
                "src/d.txt": "delta\n",
            }
        )
        case_results = []
        for case_id, path, content in [
            ("case-a", "src/a.txt", "alpha updated\n"),
            ("case-b", "src/b.txt", "bravo updated\n"),
            ("case-c", "src/c.txt", "charlie updated\n"),
            ("case-d", "src/d.txt", "delta updated\n"),
        ]:
            self._prepare_case_patch(
                case_id,
                lambda workspace, path=path, content=content: (
                    workspace / path
                ).write_text(content, encoding="utf-8"),
            )
            case_results.append(self._case_result(case_id))

        def fake_synthesize_combined_delivery_patch(
            *,
            delivery_entry: dict,
            case_items: list[DeliveryPatchCase],
            **_kwargs,
        ) -> PatchArtifact:
            case_ids = [item.case_id for item in case_items]
            if case_ids == ["case-a", "case-b"]:
                raise RuntimeError("synthetic patch synthesis failure")
            changed_files = [
                path
                for item in case_items
                for path in file_change_paths(item.mitigator_file_changes)
            ]
            file_changes = [
                {
                    "path": path,
                    "status": "upsert",
                    "content": "synthetic combined content\n",
                    "content_encoding": "utf-8",
                }
                for path in changed_files
            ]
            return PatchArtifact.model_validate(
                {
                    "patch_diff": "synthetic combined patch",
                    "file_changes": file_changes,
                }
            )

        with patch(
            "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
            side_effect=fake_synthesize_combined_delivery_patch,
        ):
            result = await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "first combined delivery",
                            "case_ids": ["case-a", "case-b"],
                        },
                        {
                            "strategy": "combined",
                            "reason": "second combined delivery",
                            "case_ids": ["case-c", "case-d"],
                        },
                    ]
                ),
            )

        assert len(result["deliveries"]) == 1
        assert result["deliveries"][0]["case_ids"] == ["case-c", "case-d"]

    @pytest.mark.asyncio
    async def test_direct_combined_deliveries_use_baseline_snapshot(
        self,
    ) -> None:
        """Prevent one combined delivery from becoming the next delivery's baseline."""
        self._write_workspace(
            {
                "src/a.txt": "alpha\n",
                "src/b.txt": "bravo\n",
                "src/c.txt": "charlie\n",
                "src/d.txt": "delta\n",
            }
        )
        case_results = []
        for case_id, path, content in [
            ("case-a", "src/a.txt", "alpha updated\n"),
            ("case-b", "src/b.txt", "bravo updated\n"),
            ("case-c", "src/c.txt", "charlie updated\n"),
            ("case-d", "src/d.txt", "delta updated\n"),
        ]:
            self._prepare_case_patch(
                case_id,
                lambda workspace, path=path, content=content: (
                    workspace / path
                ).write_text(content, encoding="utf-8"),
            )
            case_results.append(self._case_result(case_id))

        workspace_snapshot_tar_paths: list[Path] = []

        def fake_synthesize_combined_delivery_patch(
            *,
            workspace_snapshot_tar_path: Path,
            delivery_entry: dict,
            case_items: list[DeliveryPatchCase],
            **_kwargs,
        ) -> PatchArtifact:
            workspace_snapshot_tar_paths.append(workspace_snapshot_tar_path)
            return PatchArtifact.model_validate(
                {
                    "patch_diff": "",
                    "file_changes": [],
                }
            )

        with patch(
            "sec_review_agents.delivery_stages.execution.stage.synthesize_combined_delivery_patch",
            side_effect=fake_synthesize_combined_delivery_patch,
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=case_results,
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "first combined delivery",
                            "case_ids": ["case-a", "case-b"],
                        },
                        {
                            "strategy": "combined",
                            "reason": "second combined delivery",
                            "case_ids": ["case-c", "case-d"],
                        },
                    ]
                ),
            )

        expected_workspace_snapshot_tar_path = (
            self.local_root / "workspace.snapshot.tar"
        )
        assert workspace_snapshot_tar_paths == [
            expected_workspace_snapshot_tar_path,
            expected_workspace_snapshot_tar_path,
        ]

    @pytest.mark.asyncio
    async def test_delivery_artifact_lists_changed_files(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
            }
        )
        self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1")

        await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[case_result],
            delivery_plan=self._delivery_plan(),
        )

        artifact = self._read_artifact("case-1")
        assert "changed_files" not in artifact
        assert "cases" not in artifact
        assert artifact["case_ids"] == ["case-1"]

    @pytest.mark.asyncio
    async def test_delivery_artifact_changed_files_reflect_final_merge(self) -> None:
        self._write_workspace(
            {
                "src/a.txt": "alpha\n",
                "src/b.txt": "bravo\n",
                "src/c.txt": "charlie\n",
            }
        )
        self._prepare_case_patch(
            "case-a",
            lambda workspace: (workspace / "src/a.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        self._prepare_case_patch(
            "case-b",
            lambda workspace: (workspace / "src/b.txt").write_text(
                "bravo updated\n", encoding="utf-8"
            ),
        )
        case_a = self._case_result("case-a")
        case_b = self._case_result("case-b")
        case_b["review_record"]["mitigation"]["file_changes"].append(
            {
                "path": "src/c.txt",
                "status": "upsert",
                "content": "charlie updated\n",
                "content_encoding": "utf-8",
            }
        )

        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            create_agent_calls.append(kwargs)
            merge_workspace = self._latest_patch_synthesis_workspace(create_agent_calls)
            (merge_workspace / "src/a.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            )
            (merge_workspace / "src/b.txt").write_text(
                "bravo updated\n", encoding="utf-8"
            )
            return self._delivery_agent_response(
                Path(kwargs["workspace_root_path"]), ["src/a.txt", "src/b.txt"]
            )

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.run_patch_synthesis_agent",
                side_effect=_invoke_side_effect,
            ),
        ):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=[case_a, case_b],
                delivery_plan=self._delivery_plan(
                    [
                        {
                            "strategy": "combined",
                            "reason": "write-overlap",
                            "case_ids": ["case-a", "case-b"],
                            "changed_files": ["src/fake-from-planner.txt"],
                        },
                    ]
                ),
            )

        delivery_execution_input = json.loads(
            (
                self.run_artifacts
                / "delivery-execution"
                / "delivery-execution-input.json"
            ).read_text(encoding="utf-8")
        )
        assert "changed_files" not in delivery_execution_input["deliveries"][0]
        artifact = self._read_artifact("combined-b674cd56f5")
        assert "changed_files" not in artifact
        assert [item["path"] for item in artifact["file_changes"]] == [
            "src/a.txt",
            "src/b.txt",
        ]
        assert "cases" not in artifact
        assert artifact["case_ids"] == ["case-a", "case-b"]
