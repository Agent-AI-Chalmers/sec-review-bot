import subprocess
from pathlib import Path

import pytest

from sec_review_agents.review_stages.verification.stage import (
    _apply_workspace_patch,
)


def _init_workspace_git_repo(workspace: Path) -> None:
    """Make the workspace its own repository root, as a restored snapshot is.

    `git apply` resolves patch paths against the repository root it finds, so a
    workspace that is a subdirectory of some other repository silently skips every
    path. Production restores a snapshot that already contains `.git`, and these
    tests must not depend on where the test runner put its temporary directory.
    """
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)


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

    _apply_workspace_patch(
        workspace_path=workspace,
        workspace_patch=patch_content,
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

    with pytest.raises(RuntimeError):
        _apply_workspace_patch(
            workspace_path=workspace,
            workspace_patch=patch_content,
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
        _apply_workspace_patch(
            workspace_path=workspace,
            workspace_patch=patch_content,
        )


def test_apply_workspace_patch_ignores_empty_patch(
    tmp_path: Path,
) -> None:
    workspace = tmp_path
    (workspace / "app.py").write_text("print('baseline')\n", encoding="utf-8")

    _apply_workspace_patch(
        workspace_path=workspace,
        workspace_patch=None,
    )

    assert (workspace / "app.py").read_text(encoding="utf-8") == ("print('baseline')\n")


def test_apply_workspace_patch_rejects_a_workspace_inside_another_repository(
    tmp_path: Path,
) -> None:
    """`git apply` exits 0 while skipping every path when the workspace is a
    subdirectory of another repository. Without the guard the verifier would run on the
    unpatched baseline and report success, so the skip must fail loudly instead.
    """
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
        _apply_workspace_patch(
            workspace_path=workspace,
            workspace_patch=patch_content,
        )

    assert "return payload" in target.read_text(encoding="utf-8")
