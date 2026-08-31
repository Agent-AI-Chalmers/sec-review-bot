import subprocess
from pathlib import Path

from sec_review_agents.runtime.changed_files_acceptance_middleware import (
    check_changed_files_acceptance,
)
from sec_review_agents.workspace.patches import (
    check_workspace_patch_applies_to_fresh_baseline,
)
from sec_review_agents.workspace.snapshots import (
    WORKSPACE_SNAPSHOT_TAR_NAME,
    create_workspace_snapshot_tar,
)


def _run_git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )


def _create_repo(repo: Path, files: dict[str, str]) -> None:
    repo.mkdir(parents=True)
    for path, content in files.items():
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    _run_git(repo, "init")
    _run_git(repo, "add", ".")
    _run_git(
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "initial",
    )


def _copy_repo(source: Path, destination: Path) -> None:
    subprocess.run(
        ["cp", "-a", str(source), str(destination)],
        check=True,
        capture_output=True,
        text=True,
    )


def _baseline_snapshot(local_root: Path, run_artifacts: Path) -> Path:
    snapshot_tar = run_artifacts / WORKSPACE_SNAPSHOT_TAR_NAME
    create_workspace_snapshot_tar(
        workspace_path=local_root / "workspace",
        tar_path=snapshot_tar,
    )
    return snapshot_tar


def test_retries_when_declared_changed_files_are_invalid(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    _create_repo(source_workspace, {"a.txt": "old\n"})
    _copy_repo(source_workspace, workspace)

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": ["/workspace"],
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert not result.accepted
    assert result.error is None
    assert result.retry_prompt is not None
    assert "Patch declaration failed" in result.retry_prompt
    assert "declared_changed_files" in result.retry_prompt


def test_raises_when_invalid_declared_changed_files_exhaust_retry(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    _create_repo(source_workspace, {"a.txt": "old\n"})
    _copy_repo(source_workspace, workspace)

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": ["/workspace"],
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=1,
        max_retries=1,
    )

    assert not result.accepted
    assert result.error is not None


def test_retries_when_declared_changed_files_is_not_a_list(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    _create_repo(source_workspace, {"a.txt": "old\n"})
    _copy_repo(source_workspace, workspace)

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": "a.txt",
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert not result.accepted
    assert result.error is None
    assert result.retry_prompt is not None
    assert "Patch declaration failed" in result.retry_prompt
    assert "declared_changed_files must be a list" in result.retry_prompt


def test_errors_when_non_list_declared_changed_files_exhaust_retry(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    _create_repo(source_workspace, {"a.txt": "old\n"})
    _copy_repo(source_workspace, workspace)

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": {"path": "a.txt"},
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=1,
        max_retries=1,
    )

    assert not result.accepted
    assert isinstance(result.error, ValueError)
    assert str(result.error) == "declared_changed_files must be a list."


def test_missing_declared_changed_files_is_empty_declaration(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    _create_repo(source_workspace, {"a.txt": "old\n"})
    _copy_repo(source_workspace, workspace)

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "no publishable patch",
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert result.accepted


def test_retries_when_declared_path_is_not_observed(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    (tmp_path / "artifacts").mkdir()
    _create_repo(
        source_workspace,
        {
            "a.txt": "old\n",
            "b.txt": "old\n",
        },
    )
    _copy_repo(source_workspace, workspace)
    (workspace / "a.txt").write_text("new\n", encoding="utf-8")

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": ["b.txt"],
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert not result.accepted
    assert result.error is None
    assert result.retry_prompt is not None
    assert "Patch reconciliation failed" in result.retry_prompt
    assert "Declared changed files" in result.retry_prompt
    assert "- b.txt" in result.retry_prompt
    assert "Observed workspace changed files" in result.retry_prompt
    assert "- a.txt" in result.retry_prompt


def test_passes_when_declared_path_matches_observed_diff(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    (tmp_path / "artifacts").mkdir()
    _create_repo(source_workspace, {"a.txt": "old\n"})
    _copy_repo(source_workspace, workspace)
    (workspace / "a.txt").write_text("new\n", encoding="utf-8")

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": ["a.txt"],
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert result.accepted


def test_passes_empty_declared_paths_even_when_workspace_has_runtime_drift(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    (tmp_path / "artifacts").mkdir()
    _create_repo(source_workspace, {"a.txt": "old\n"})
    _copy_repo(source_workspace, workspace)
    (workspace / "a.txt").write_text("runtime drift\n", encoding="utf-8")

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "no publishable patch",
            "declared_changed_files": [],
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert result.accepted


def test_passes_when_observed_diff_has_extra_undeclared_paths(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    (tmp_path / "artifacts").mkdir()
    _create_repo(
        source_workspace,
        {
            "a.txt": "old\n",
            "b.txt": "old\n",
        },
    )
    _copy_repo(source_workspace, workspace)
    (workspace / "a.txt").write_text("new\n", encoding="utf-8")
    (workspace / "b.txt").write_text("new\n", encoding="utf-8")

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": ["a.txt"],
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert result.accepted


def test_retries_when_declared_patch_does_not_apply_to_fresh_baseline(
    tmp_path: Path,
) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    workspace = tmp_path / "writable-workspace"
    (tmp_path / "artifacts").mkdir()
    _create_repo(source_workspace, {"a.txt": "different\n"})
    _create_repo(workspace, {"a.txt": "old\n"})
    (workspace / "a.txt").write_text("new\n", encoding="utf-8")

    result = check_changed_files_acceptance(
        structured_response={
            "overview": "updated",
            "declared_changed_files": ["a.txt"],
        },
        worktree_path=workspace,
        baseline_snapshot_tar_path=_baseline_snapshot(
            local_root, tmp_path / "artifacts" / "run-1"
        ),
        retry_attempts=0,
        max_retries=1,
    )

    assert not result.accepted
    assert result.error is None
    assert result.retry_prompt is not None
    assert "Patch apply check failed" in result.retry_prompt
    assert "- a.txt" in result.retry_prompt


def test_fresh_baseline_patch_check_rejects_unsafe_paths(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    source_workspace = local_root / "workspace"
    _create_repo(source_workspace, {"a.txt": "old\n"})

    error = check_workspace_patch_applies_to_fresh_baseline(
        _baseline_snapshot(local_root, tmp_path / "artifacts" / "run-1"),
        (
            "diff --git a/../escape.txt b/../escape.txt\n"
            "new file mode 100644\n"
            "index 0000000..e69de29\n"
            "--- /dev/null\n"
            "+++ b/../escape.txt\n"
        ),
    )

    assert isinstance(error, str)
    assert error != ""
