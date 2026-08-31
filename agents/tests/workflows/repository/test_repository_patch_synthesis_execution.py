import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import Mock, patch

import pytest

from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.workflows.execution_request import InternalWorkflowRequest
from sec_review_agents.workflows.repository import direct as repository_direct
from sec_review_agents.workflows.repository.workflow import (
    plan_repository_delivery_activity,
    prepare_repository_delivery_execution_activity,
)
from sec_review_agents.workspace.file_changes import (
    FileChange,
    collect_publishable_file_changes,
)
from sec_review_agents.workspace.patches import (
    derive_changed_files_from_patch,
    observe_workspace_changed_files,
    persist_workspace_patch,
)
from sec_review_agents.workspace.snapshots import create_workspace_snapshot_tar


def _build_file_changes_from_workspace_patch(
    *,
    source_workspace_path: Path,
    patch_path: Path | str | None,
    include_paths: list[str] | None = None,
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
        return collect_publishable_file_changes(
            patched_workspace_path,
            include_paths or derive_changed_files_from_patch(patch_content),
        )


async def _execute_delivery_direct_for_test(
    *,
    input_data: dict,
    keep_case_results: list[dict],
    delivery_plan: dict,
) -> dict[str, Any]:
    workspace_path = Path(input_data["input_bundle_root_path"]) / "workspace"
    if workspace_path.is_dir():
        create_workspace_snapshot_tar(
            workspace_path=workspace_path,
            tar_path=Path(input_data["bundle_paths"]["workspace_snapshot_tar_path"]),
        )
    request = InternalWorkflowRequest(
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
        return await repository_direct.run_repository_delivery_direct(
            request,
            keep_case_results,
        )


async def _run_repository_delivery_workflow_steps_for_test(
    *,
    input_data: dict,
    case_results: list[dict],
) -> dict[str, Any]:
    request = InternalWorkflowRequest(
        workflow="repository-review",
        run_id=input_data["run_id"],
        prepared_input=input_data,
        timeout_seconds=60,
        runtime_context={},
    )
    delivery_plan = await plan_repository_delivery_activity(
        request,
        case_results,
    )
    with patch.object(
        repository_direct,
        "plan_repository_delivery_activity",
        side_effect=lambda *args, **kwargs: delivery_plan,
    ):
        return await repository_direct.run_repository_delivery_direct(
            request,
            case_results,
        )


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

        self.input_data = {
            "run_id": self.run_id,
            "scan_target": {
                "ref": "main",
                "target_branch": "main",
                "default_branch": "main",
            },
            "input_bundle_root_path": str(self.local_root),
            "artifact_root_path": str(self.run_artifacts),
            "artifact_paths": {"cases": str(self.case_artifacts)},
            "bundle_paths": {
                "workspace_snapshot_tar_path": str(
                    self.local_root / "workspace.snapshot.tar"
                )
            },
        }

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
            baseline_snapshot_tar_path: Path,
            patch_synthesis_root: Path,
            delivery_entry: dict,
            case_items: list[dict],
        ) -> dict:
            changed_files = [
                path
                for case_item in case_items
                for path in case_item.get("mitigator_changed_files", [])
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
            return {
                "delivery_id": delivery_entry["delivery_id"],
                "status": "ready",
                "error": None,
                "patch_path": None,
                "patch_diff": "",
                "changed_files": changed_files,
                "file_changes": file_changes,
                "applied_case_ids": delivery_entry["case_ids"],
            }

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

        patch_root = self.case_artifacts / case_id / "mitigator"
        return persist_workspace_patch(
            case_workspace_root,
            patch_root_path=patch_root,
            include_paths=observe_workspace_changed_files(case_workspace_root),
        )

    def _case_result(
        self,
        case_id: str,
        changed_files: list[str],
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
                include_paths=changed_files or None,
            )
            if patch_diff
            else []
        )
        mitigation = {
            "overview": f"Mitigation overview for {case_id}.",
            "changed_files": changed_files,
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

    def _delivery_agent_response(self, paths: list[str]) -> dict:
        return {
            "declared_changed_files": paths,
        }

    def _record_patch_synthesis_agent_graph(self, calls: list[dict]):
        def _side_effect(*args, **kwargs):
            calls.append(kwargs)
            return Mock()

        return _side_effect

    def _latest_patch_synthesis_workspace(self, calls: list[dict]) -> Path:
        assert calls
        return Path(calls[-1]["workspace_root_path"])

    def _delivery_plan(self, deliveries: list[dict] | None = None) -> dict:
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
        return {
            "deliveries": workbench_state.export_deliveries(),
        }

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
        case_one = self._case_result("case-1", ["src/single.py"])
        case_two = self._case_result("case-2", ["src/combined.py"])
        case_one["review_record"]["mitigation"]["patch_diff"] = "single diff"
        case_two["review_record"]["mitigation"]["patch_diff"] = "combined diff"
        case_one["review_record"]["mitigation"]["file_changes"] = [
            {"path": "src/single.py", "content": "single content"}
        ]
        case_two["review_record"]["mitigation"]["file_changes"] = [
            {"path": "src/combined.py", "content": "combined content"}
        ]
        delivery_plan = {
            "deliveries": [
                {
                    "delivery_id": "delivery-single",
                    "strategy": "single",
                    "case_ids": ["case-1"],
                    "reason": "single delivery",
                },
                {
                    "delivery_id": "delivery-combined",
                    "strategy": "combined",
                    "case_ids": ["case-2"],
                    "reason": "combined delivery",
                },
            ]
        }
        request = InternalWorkflowRequest(
            workflow="repository-review",
            run_id=self.run_id,
            prepared_input=self.input_data,
            timeout_seconds=60,
            runtime_context={},
        )

        delivery_execution_input = prepare_repository_delivery_execution_activity(
            request,
            [case_one, case_two],
            delivery_plan,
        )

        assert delivery_execution_input["keep_case_ids"] == ["case-1", "case-2"]
        assert "cases_artifacts_root_path" not in delivery_execution_input
        single_case = delivery_execution_input["single_delivery_execution_items"][0][
            "case_items"
        ][0]
        assert single_case["mitigator_file_changes"] == [
            {"path": "src/single.py", "content": "single content"}
        ]
        combined_case = delivery_execution_input["combined_delivery_execution_items"][
            0
        ]["case_items"][0]
        assert combined_case["mitigator_changed_files"] == ["src/combined.py"]
        assert "mitigator_file_changes" not in combined_case
        assert combined_case["mitigator_patch_diff"] == "combined diff"

    @pytest.mark.asyncio
    async def test_single_case_publishable_modify(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
                "src/keep.txt": "keep\n",
            }
        )
        patch_artifact = self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1", patch_artifact["changed_files"])

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

    def test_persist_workspace_patch_uses_git_diff_and_skips_ignored_untracked_files(
        self,
    ) -> None:
        self._write_workspace(
            {
                ".gitignore": ".next/\n",
                "src/app.txt": "alpha\n",
            }
        )
        self._init_workspace_git_repo()

        (self.workspace_root / "src/app.txt").write_text(
            "alpha updated\n", encoding="utf-8"
        )
        generated_file = self.workspace_root / ".next" / "cache" / "trace.txt"
        generated_file.parent.mkdir(parents=True, exist_ok=True)
        generated_file.write_text("generated\n", encoding="utf-8")

        patch_root = self.case_artifacts / "case-git" / "patch"

        patch_artifact = persist_workspace_patch(
            self.workspace_root,
            patch_root_path=patch_root,
            include_paths=observe_workspace_changed_files(self.workspace_root),
        )

        assert patch_artifact["changed_files"] == ["src/app.txt"]
        assert (
            "diff --git a/src/app.txt b/src/app.txt" in patch_artifact["patch_content"]
        )
        assert patch_artifact["patch_diff"] == patch_artifact["patch_content"]
        assert patch_artifact["file_changes"] == [
            {
                "path": "src/app.txt",
                "status": "upsert",
                "mode": "100644",
                "content": "alpha updated\n",
                "content_encoding": "utf-8",
            }
        ]
        assert ".next/cache/trace.txt" not in patch_artifact["patch_content"]

    def test_persist_workspace_patch_disables_git_diff_color(self) -> None:
        self._write_workspace({"src/app.txt": "alpha\n"})
        self._init_workspace_git_repo()
        (self.workspace_root / "src/app.txt").write_text(
            "alpha updated\n", encoding="utf-8"
        )

        observed_git_diff_commands: list[list[str]] = []
        original_run = subprocess.run

        def record_git_diff(*args, **kwargs):
            command = args[0] if args else kwargs.get("args")
            if isinstance(command, list) and command[:2] == ["git", "diff"]:
                observed_git_diff_commands.append(command)
            return original_run(*args, **kwargs)

        with patch(
            "sec_review_agents.workspace.patches.subprocess.run", record_git_diff
        ):
            persist_workspace_patch(
                self.workspace_root,
                patch_root_path=self.case_artifacts / "case-git-no-color" / "patch",
                include_paths=["src/app.txt"],
            )

        assert observed_git_diff_commands
        assert all("--no-color" in command for command in observed_git_diff_commands)

    def test_persist_workspace_patch_requires_git_workspace(self) -> None:
        self._write_workspace({"src/app.txt": "alpha\n"})
        self._init_workspace_git_repo()

        patch_root = self.case_artifacts / "case-git-missing-writable" / "patch"

        with pytest.raises(RuntimeError, match="git-initialized workspace"):
            persist_workspace_patch(
                self.local_root,
                patch_root_path=patch_root,
                include_paths=[],
            )

    def test_persist_workspace_patch_can_scope_to_declared_paths(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
                "README.md": "baseline\n",
            }
        )
        self._init_workspace_git_repo()

        (self.workspace_root / "src/app.txt").write_text(
            "alpha updated\n", encoding="utf-8"
        )
        (self.workspace_root / "README.md").write_text(
            "runtime noise\n", encoding="utf-8"
        )
        tap_file = self.workspace_root / ".tap" / "test-results" / "app.tap"
        tap_file.parent.mkdir(parents=True, exist_ok=True)
        tap_file.write_text("generated\n", encoding="utf-8")

        patch_root = self.case_artifacts / "case-git-scoped" / "patch"

        patch_artifact = persist_workspace_patch(
            self.workspace_root,
            patch_root_path=patch_root,
            include_paths=["src/app.txt"],
        )

        assert patch_artifact["changed_files"] == ["src/app.txt"]
        assert (
            "diff --git a/src/app.txt b/src/app.txt" in patch_artifact["patch_content"]
        )
        assert [item["path"] for item in patch_artifact["file_changes"]] == [
            "src/app.txt"
        ]
        assert "README.md" not in patch_artifact["patch_content"]
        assert ".tap/test-results/app.tap" not in patch_artifact["patch_content"]

    def test_persist_workspace_patch_normalizes_renames_to_delete_and_upsert(
        self,
    ) -> None:
        self._write_workspace({"src/old.txt": "same content\n"})
        self._init_workspace_git_repo()
        subprocess.run(
            ["git", "config", "diff.renames", "true"],
            cwd=self.workspace_root,
            check=True,
            capture_output=True,
            text=True,
        )

        (self.workspace_root / "src/new.txt").write_text(
            "same content\n", encoding="utf-8"
        )
        (self.workspace_root / "src/old.txt").unlink()

        patch_root = self.case_artifacts / "case-git-rename" / "patch"

        patch_artifact = persist_workspace_patch(
            self.workspace_root,
            patch_root_path=patch_root,
            include_paths=observe_workspace_changed_files(self.workspace_root),
        )

        assert patch_artifact["changed_files"] == ["src/new.txt", "src/old.txt"]
        assert "rename from src/old.txt" not in patch_artifact["patch_content"]
        assert "rename to src/new.txt" not in patch_artifact["patch_content"]
        assert patch_artifact["file_changes"] == [
            {
                "path": "src/new.txt",
                "status": "upsert",
                "mode": "100644",
                "content": "same content\n",
                "content_encoding": "utf-8",
            },
            {
                "path": "src/old.txt",
                "status": "deleted",
            },
        ]

    def test_persist_workspace_patch_empty_scope_emits_empty_patch(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
            }
        )
        self._init_workspace_git_repo()

        (self.workspace_root / "src/app.txt").write_text(
            "alpha updated\n", encoding="utf-8"
        )

        patch_root = self.case_artifacts / "case-git-empty-scope" / "patch"

        patch_artifact = persist_workspace_patch(
            self.workspace_root,
            patch_root_path=patch_root,
            include_paths=[],
        )

        assert patch_artifact["patch_content"] == ""
        assert patch_artifact["patch_diff"] == ""
        assert patch_artifact["changed_files"] == []
        assert patch_artifact["file_changes"] == []

    def test_persist_workspace_patch_preserves_symlink_semantics(self) -> None:
        self._write_workspace(
            {
                "contrib/gce/configure.sh": "echo baseline\n",
            }
        )
        os.symlink("../contrib/gce", self.workspace_root / "cluster-gce")
        self._init_workspace_git_repo()

        (self.workspace_root / "contrib/gce/configure.sh").write_text(
            "echo updated\n", encoding="utf-8"
        )

        patch_root = self.case_artifacts / "case-git-symlink" / "patch"

        patch_artifact = persist_workspace_patch(
            self.workspace_root,
            patch_root_path=patch_root,
            include_paths=observe_workspace_changed_files(self.workspace_root),
        )

        assert patch_artifact["changed_files"] == ["contrib/gce/configure.sh"]
        assert "diff --git a/cluster-gce" not in patch_artifact["patch_content"]
        assert "deleted file mode 120000" not in patch_artifact["patch_content"]

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
        patch_artifact = self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/remove.txt").unlink(),
        )
        case_result = self._case_result("case-1", patch_artifact["changed_files"])

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
        case_result = self._case_result("case-1", [])
        case_result["review_record"]["mitigation"]["patch_diff"] = None
        case_result["review_record"]["mitigation"]["changed_files"] = ["src/app.txt"]
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
        case_result = self._case_result("case-1", [])
        case_result["review_record"]["mitigation"]["patch_diff"] = None
        case_result["review_record"]["mitigation"]["changed_files"] = ["src/app.txt"]
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
        patch = self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "new\n", encoding="utf-8"
            ),
        )

        result = await _execute_delivery_direct_for_test(
            input_data=self.input_data,
            keep_case_results=[
                self._case_result("case-1", patch["changed_files"]),
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
            self._case_result("case-one", patch_one["changed_files"]),
            self._case_result("case-two", patch_two["changed_files"]),
        ]
        Path(patch_one["patch_path"]).unlink()
        Path(patch_two["patch_path"]).unlink()

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            invoke_calls["count"] += 1
            for transcript_path in kwargs["transcript_paths"]:
                transcript_path.parent.mkdir(parents=True, exist_ok=True)
                transcript_path.write_text("{}\n", encoding="utf-8")
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/app.txt").write_text(
                    "value=3\n", encoding="utf-8"
                )
            return self._delivery_agent_response(["src/app.txt"])

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph(
                    create_agent_calls
                ),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
        assert (patch_synthesis_artifacts / "transcript.jsonl").exists()
        assert (patch_synthesis_artifacts / "workspace.patch").exists()

    @pytest.mark.asyncio
    async def test_delivery_agent_records_scope_expansion(self) -> None:
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
            self._case_result("case-one", patch_one["changed_files"]),
            self._case_result("case-two", patch_two["changed_files"]),
        ]

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            invoke_calls["count"] += 1
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/other.txt").write_text(
                    "boom\n", encoding="utf-8"
                )
            return self._delivery_agent_response(["src/other.txt"])

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph(
                    create_agent_calls
                ),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
            self._case_result("case-one", patch_one["changed_files"]),
            self._case_result("case-two", patch_two["changed_files"]),
        ]

        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            merge_workspace = self._latest_patch_synthesis_workspace(create_agent_calls)
            (merge_workspace / "src/app.txt").write_text("value=3\n", encoding="utf-8")
            (merge_workspace / "dist").mkdir(parents=True, exist_ok=True)
            (merge_workspace / "dist/bundle.js").write_text(
                "generated\n", encoding="utf-8"
            )
            return self._delivery_agent_response(["src/app.txt"])

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph(
                    create_agent_calls
                ),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
            self._case_result("case-one", patch_one["changed_files"]),
            self._case_result("case-two", patch_two["changed_files"]),
        ]

        invoke_calls = {"count": 0}

        def _invoke_side_effect(*args, **kwargs):
            invoke_calls["count"] += 1
            return {}

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph([]),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
            self._case_result("case-one", patch_one["changed_files"]),
            self._case_result("case-two", patch_two["changed_files"]),
        ]

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            invoke_calls["count"] += 1
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/app.txt").write_text(
                    "value=3\n", encoding="utf-8"
                )
                return self._delivery_agent_response(["workspace/src/app.txt"])
            return self._delivery_agent_response(["workspace/src/app.txt"])

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph(
                    create_agent_calls
                ),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
        patch_one = self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "package-lock.json").write_text(
                large_content.replace("line-1000", "line-case-one"),
                encoding="utf-8",
            ),
        )
        patch_two = self._prepare_case_patch(
            "case-two",
            lambda workspace: (workspace / "package-lock.json").write_text(
                large_content.replace("line-1000", "line-case-two"),
                encoding="utf-8",
            ),
        )
        case_results = [
            self._case_result("case-one", patch_one["changed_files"]),
            self._case_result("case-two", patch_two["changed_files"]),
        ]

        invoke_calls = {"count": 0}
        invoke_user_prompts: list[str] = []
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
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
            return self._delivery_agent_response(["package-lock.json"])

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph(
                    create_agent_calls
                ),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
        assert "available" not in patch_synthesis_brief
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

        patch_one = self._prepare_case_patch(
            "case-one",
            lambda workspace: (workspace / "src/a.txt").write_text(
                "A1\n", encoding="utf-8"
            ),
        )

        def _mutate_case_two(workspace: Path) -> None:
            (workspace / "src/a.txt").write_text("A2\n", encoding="utf-8")
            (workspace / "src/b.txt").write_text("B2\n", encoding="utf-8")

        patch_two = self._prepare_case_patch("case-two", _mutate_case_two)
        case_results = [
            self._case_result("case-one", patch_one["changed_files"]),
            self._case_result("case-two", patch_two["changed_files"]),
        ]

        invoke_calls = {"count": 0}
        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            invoke_calls["count"] += 1
            if invoke_calls["count"] == 1:
                merge_workspace = self._latest_patch_synthesis_workspace(
                    create_agent_calls
                )
                (merge_workspace / "src/a.txt").write_text("A2\n", encoding="utf-8")
                (merge_workspace / "src/b.txt").write_text("B2\n", encoding="utf-8")
            return self._delivery_agent_response(["src/a.txt", "src/b.txt"])

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph(
                    create_agent_calls
                ),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
        patch_artifact = self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1", patch_artifact["changed_files"])

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
        patch_artifact = self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1", patch_artifact["changed_files"])
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
        patch_artifact = self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1", patch_artifact["changed_files"])

        with patch(
            "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph"
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
        case_result = self._case_result("case-1", [])

        with pytest.raises(ValueError, match="Unknown delivery strategy: 'legacy'"):
            await _execute_delivery_direct_for_test(
                input_data=self.input_data,
                keep_case_results=[case_result],
                delivery_plan={
                    "deliveries": [
                        {
                            "delivery_id": "delivery-invalid",
                            "strategy": "legacy",
                            "case_ids": ["case-1"],
                            "reason": "bad strategy",
                        }
                    ],
                },
            )

    @pytest.mark.asyncio
    async def test_delivery_stage_skips_planning_when_no_cases_are_kept(self) -> None:
        blocked_case = self._case_result("case-1", ["src/app.txt"])
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
        patch_a = self._prepare_case_patch(
            "case-a",
            lambda workspace: (workspace / "src/a.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        patch_b = self._prepare_case_patch(
            "case-b",
            lambda workspace: (workspace / "src/b.txt").write_text(
                "bravo updated\n", encoding="utf-8"
            ),
        )
        case_results = [
            self._case_result("case-a", patch_a["changed_files"]),
            self._case_result("case-b", patch_b["changed_files"]),
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
            patch_artifact = self._prepare_case_patch(
                case_id,
                lambda workspace, path=path, content=content: (
                    workspace / path
                ).write_text(content, encoding="utf-8"),
            )
            case_results.append(
                self._case_result(case_id, patch_artifact["changed_files"])
            )

        def fake_synthesize_combined_delivery_patch(
            *,
            delivery_entry: dict,
            case_items: list[dict],
            **_kwargs,
        ) -> dict:
            case_ids = [item["case_id"] for item in case_items]
            if case_ids == ["case-a", "case-b"]:
                raise RuntimeError("synthetic patch synthesis failure")
            changed_files = [
                path for item in case_items for path in item["mitigator_changed_files"]
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
            return {
                "delivery_id": delivery_entry["delivery_id"],
                "status": "ready",
                "error": None,
                "patch_path": None,
                "patch_diff": "synthetic combined patch",
                "changed_files": changed_files,
                "file_changes": file_changes,
                "applied_case_ids": case_ids,
            }

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
            patch_artifact = self._prepare_case_patch(
                case_id,
                lambda workspace, path=path, content=content: (
                    workspace / path
                ).write_text(content, encoding="utf-8"),
            )
            case_results.append(
                self._case_result(case_id, patch_artifact["changed_files"])
            )

        baseline_snapshot_tar_paths: list[Path] = []

        def fake_synthesize_combined_delivery_patch(
            *,
            baseline_snapshot_tar_path: Path,
            delivery_entry: dict,
            case_items: list[dict],
            **_kwargs,
        ) -> dict:
            baseline_snapshot_tar_paths.append(baseline_snapshot_tar_path)
            case_ids = [item["case_id"] for item in case_items]
            return {
                "delivery_id": delivery_entry["delivery_id"],
                "status": "ready",
                "error": None,
                "patch_path": None,
                "patch_diff": "",
                "changed_files": [],
                "file_changes": [],
                "applied_case_ids": case_ids,
            }

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

        expected_baseline_snapshot_tar_path = self.local_root / "workspace.snapshot.tar"
        assert baseline_snapshot_tar_paths == [
            expected_baseline_snapshot_tar_path,
            expected_baseline_snapshot_tar_path,
        ]

    @pytest.mark.asyncio
    async def test_delivery_artifact_lists_changed_files(self) -> None:
        self._write_workspace(
            {
                "src/app.txt": "alpha\n",
            }
        )
        patch_artifact = self._prepare_case_patch(
            "case-1",
            lambda workspace: (workspace / "src/app.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        case_result = self._case_result("case-1", patch_artifact["changed_files"])

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
        patch_a = self._prepare_case_patch(
            "case-a",
            lambda workspace: (workspace / "src/a.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            ),
        )
        patch_b = self._prepare_case_patch(
            "case-b",
            lambda workspace: (workspace / "src/b.txt").write_text(
                "bravo updated\n", encoding="utf-8"
            ),
        )
        case_a = self._case_result("case-a", patch_a["changed_files"])
        case_b = self._case_result("case-b", patch_b["changed_files"])
        case_b["review_record"]["mitigation"]["changed_files"] = [
            "src/b.txt",
            "src/c.txt",
        ]

        create_agent_calls: list[dict] = []

        def _invoke_side_effect(*args, **kwargs):
            merge_workspace = self._latest_patch_synthesis_workspace(create_agent_calls)
            (merge_workspace / "src/a.txt").write_text(
                "alpha updated\n", encoding="utf-8"
            )
            (merge_workspace / "src/b.txt").write_text(
                "bravo updated\n", encoding="utf-8"
            )
            return self._delivery_agent_response(["src/a.txt", "src/b.txt"])

        with (
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.create_patch_synthesis_agent_graph",
                side_effect=self._record_patch_synthesis_agent_graph(
                    create_agent_calls
                ),
            ),
            patch(
                "sec_review_agents.delivery_stages.execution.patch_synthesis.invoke_agent_runtime_graph",
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
