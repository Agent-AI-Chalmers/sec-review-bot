import subprocess
from pathlib import Path

import pytest

from sec_review_agents.workspace.patches import apply_workspace_patch


def _init_workspace_git_repo(workspace: Path) -> None:
    """Restored stage workspaces are independent Git repository roots."""
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)


def _commit_workspace(workspace: Path) -> None:
    for args in [
        ("add", "."),
        (
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@localhost",
            "commit",
            "-qm",
            "baseline",
        ),
    ]:
        subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True)


def test_apply_workspace_patch_applies_patch(tmp_path: Path) -> None:
    workspace = tmp_path
    _init_workspace_git_repo(workspace)

    target = workspace / "src" / "lib" / "jwt.ts"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('if (header.alg === "none") return payload;\n', encoding="utf-8")

    patch_content = (
        "diff --git a/src/lib/jwt.ts b/src/lib/jwt.ts\n"
        "index 1111111..2222222 100644\n"
        "--- a/src/lib/jwt.ts\n"
        "+++ b/src/lib/jwt.ts\n"
        "@@ -1 +1 @@\n"
        '-if (header.alg === "none") return payload;\n'
        '+if (header.alg === "none") return null;\n'
    )

    _commit_workspace(workspace)
    apply_workspace_patch(
        workspace_path=workspace,
        patch_content=patch_content,
    )
    patched_file = workspace / "src" / "lib" / "jwt.ts"
    assert "return null" in patched_file.read_text(encoding="utf-8")


def test_apply_workspace_patch_fails_when_patch_cannot_apply(
    tmp_path: Path,
) -> None:
    workspace = tmp_path
    _init_workspace_git_repo(workspace)

    target = workspace / "src" / "lib" / "jwt.ts"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("different baseline\n", encoding="utf-8")

    patch_content = (
        "diff --git a/src/lib/jwt.ts b/src/lib/jwt.ts\n"
        "index 1111111..2222222 100644\n"
        "--- a/src/lib/jwt.ts\n"
        "+++ b/src/lib/jwt.ts\n"
        "@@ -1 +1 @@\n"
        "-old baseline\n"
        "+new baseline\n"
    )

    _commit_workspace(workspace)
    with pytest.raises(RuntimeError):
        apply_workspace_patch(
            workspace_path=workspace,
            patch_content=patch_content,
        )


def test_apply_workspace_patch_rejects_unsafe_patch_paths(
    tmp_path: Path,
) -> None:
    workspace = tmp_path
    (workspace / "safe.txt").write_text("safe\n", encoding="utf-8")

    patch_content = (
        "diff --git a/../escape.txt b/../escape.txt\n"
        "new file mode 100644\n"
        "index 0000000..e69de29\n"
        "--- /dev/null\n"
        "+++ b/../escape.txt\n"
    )

    with pytest.raises(RuntimeError):
        apply_workspace_patch(
            workspace_path=workspace,
            patch_content=patch_content,
        )


def test_apply_workspace_patch_ignores_empty_patch(
    tmp_path: Path,
) -> None:
    workspace = tmp_path
    (workspace / "app.py").write_text("print('baseline')\n", encoding="utf-8")

    apply_workspace_patch(
        workspace_path=workspace,
        patch_content=None,
    )

    assert (workspace / "app.py").read_text(encoding="utf-8") == ("print('baseline')\n")


def test_apply_workspace_patch_rejects_a_workspace_inside_another_repository(
    tmp_path: Path,
) -> None:
    """Reconstruction must not discover and modify an enclosing repository's index."""
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True)

    workspace = tmp_path / "workspace"
    target = workspace / "src" / "lib" / "jwt.ts"
    target.parent.mkdir(parents=True)
    target.write_text('if (header.alg === "none") return payload;\n', encoding="utf-8")

    patch_content = (
        "diff --git a/src/lib/jwt.ts b/src/lib/jwt.ts\n"
        "index 1111111..2222222 100644\n"
        "--- a/src/lib/jwt.ts\n"
        "+++ b/src/lib/jwt.ts\n"
        "@@ -1 +1 @@\n"
        '-if (header.alg === "none") return payload;\n'
        '+if (header.alg === "none") return null;\n'
    )

    with pytest.raises(RuntimeError):
        apply_workspace_patch(
            workspace_path=workspace,
            patch_content=patch_content,
        )

    assert "return payload" in target.read_text(encoding="utf-8")
