import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest

from sec_review_agents.artifacts.reference import ArtifactReference
from sec_review_agents.cli.local_execution import build_local_workflow_request
from sec_review_agents.cli.local_materialization.common import (
    ReviewBundle,
    result_path_for_bundle,
)
from sec_review_agents.cli.local_materialization.issue import (
    build_local_issue_bundle,
)


def _run_git(repo_path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _create_repo(repo_path: Path) -> None:
    repo_path.mkdir()
    _run_git(repo_path, "init", "-b", "main")
    _run_git(repo_path, "config", "user.name", "Test User")
    _run_git(repo_path, "config", "user.email", "test@example.com")
    (repo_path / "README.md").write_text("# test\n", encoding="utf-8")
    _run_git(repo_path, "add", "README.md")
    _run_git(repo_path, "commit", "-m", "init")


def test_build_local_issue_bundle_omits_execution_artifacts_path(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    _create_repo(repo_path)

    bundle = build_local_issue_bundle(
        repo_path=repo_path,
        title="Local issue",
        body="Body",
        issue_number=1,
        repo_full_name_value=None,
        output_dir=output_dir,
    )

    assert "materialization" not in bundle.input
    assert "artifact_paths" not in bundle.input
    assert bundle.archive_path.is_file()
    assert not bundle.input_root_path.exists()


def test_build_local_issue_bundle_preserves_review_intent_selection(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    _create_repo(repo_path)

    bundle = build_local_issue_bundle(
        repo_path=repo_path,
        title="Local issue",
        body="Body",
        issue_number=1,
        repo_full_name_value=None,
        output_dir=output_dir,
        review_objective="audit",
        test_changes="deny",
    )

    assert bundle.input["review_intent"] == {
        "objective": "audit",
        "test_changes": "deny",
    }


def test_build_local_issue_bundle_creates_limited_history_workspace(
    tmp_path: Path,
) -> None:
    repo_path = tmp_path / "repo"
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    _create_repo(repo_path)
    (repo_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    _run_git(repo_path, "add", "app.py")
    _run_git(repo_path, "commit", "-m", "add app")
    head_sha = _run_git(repo_path, "rev-parse", "HEAD")

    bundle = build_local_issue_bundle(
        repo_path=repo_path,
        title="Local issue",
        body="Body",
        issue_number=1,
        repo_full_name_value=None,
        output_dir=output_dir,
    )

    assert not (bundle.local_root_path / "workspace").exists()
    reference = ArtifactReference.from_mapping(bundle.input["input_bundle"])
    parsed_uri = urlsplit(reference.uri)
    assert parsed_uri.scheme == "file"
    assert Path(unquote(parsed_uri.path)).is_file()
    assert head_sha


def test_local_issue_strategy_result_path_uses_strategy_suffix(tmp_path: Path) -> None:
    bundle = ReviewBundle(
        workflow="issue-review",
        run_id="run-1",
        input={},
        local_root_path=tmp_path,
        issue_strategy="two-stage",
    )

    assert result_path_for_bundle(bundle) == (
        tmp_path / "issue-review.two-stage-result.json"
    )


def test_local_input_layout_survives_validated_execution_preparation(
    tmp_path: Path,
) -> None:
    """Only validated archive extraction creates persistent execution inputs."""
    repo = tmp_path / "repo"
    _create_repo(repo)
    bundle = build_local_issue_bundle(
        repo_path=repo,
        title="Issue",
        body="Body",
        issue_number=1,
        repo_full_name_value=None,
        output_dir=tmp_path / "runs",
    )
    root = bundle.local_root_path
    assert not (root / "input").exists()
    archive = bundle.archive_path
    packed_bytes = archive.read_bytes()
    archive.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="size"):
        build_local_workflow_request(bundle, timeout_seconds=60)
    assert not bundle.input_root_path.exists()
    archive.write_bytes(packed_bytes)
    build_local_workflow_request(bundle, timeout_seconds=60)
    before = (root / "input" / "workspace.snapshot.tar").read_bytes()
    history = (root / "input" / "history" / "issue-metadata.json").read_bytes()
    archive = Path(unquote(urlsplit(bundle.input["input_bundle"]["uri"]).path))
    assert archive == root / "input.tar.zst"
    for _ in range(2):
        request = build_local_workflow_request(bundle, timeout_seconds=60)
        prepared = request.prepared_input
        assert Path(prepared.input_bundle_root_path) == root / "input"
        assert Path(prepared.workspace_snapshot_tar_path).read_bytes() == before
        assert (
            Path(prepared.history_path, "issue-metadata.json").read_bytes() == history
        )
        assert list(root.rglob("workspace.snapshot.tar")) == [
            root / "input" / "workspace.snapshot.tar"
        ]
    archive.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="size"):
        build_local_workflow_request(bundle, timeout_seconds=60)
    assert (root / "input" / "workspace.snapshot.tar").read_bytes() == before


@pytest.mark.parametrize("fail_packing", [False, True])
def test_preparation_materials_are_temporary(tmp_path, monkeypatch, fail_packing):
    """Preparation must clean its checkout and inputs even when packing fails."""
    from sec_review_agents.cli.local_materialization import issue

    repo = tmp_path / "repo"
    _create_repo(repo)
    pack = issue.pack_input_bundle
    preparation_inputs = []

    def capture_pack(bundle, *, input_root, include_incremental_window):
        preparation_inputs.append(input_root)
        assert (input_root.parent / "workspace" / ".git").is_dir()
        assert (input_root / "workspace.snapshot.tar").is_file()
        assert not bundle.input_root_path.exists()
        if fail_packing:
            raise RuntimeError("packing failed")
        return pack(
            bundle,
            input_root=input_root,
            include_incremental_window=include_incremental_window,
        )

    monkeypatch.setattr(issue, "pack_input_bundle", capture_pack)

    def build():
        return build_local_issue_bundle(
            repo_path=repo,
            title="Issue",
            body="Body",
            issue_number=1,
            repo_full_name_value=None,
            output_dir=tmp_path / "runs",
        )

    if fail_packing:
        with pytest.raises(RuntimeError, match="packing failed"):
            build()
    else:
        bundle = build()
        assert bundle.archive_path.is_file()
    assert len(preparation_inputs) == 1
    assert not preparation_inputs[0].parent.exists()
