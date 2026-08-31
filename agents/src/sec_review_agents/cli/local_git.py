import re
import subprocess
from pathlib import Path

GIT_SHA_RE = r"^[a-f0-9]{7,40}$"


def resolve_git_ref(repo_path: Path, git_ref: str) -> str:
    """Resolve a local replay ref, falling back to the caller's ref spelling."""
    process = subprocess.run(
        ["git", "rev-parse", git_ref],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        return git_ref.strip()
    return (process.stdout.strip() or git_ref).strip()


def git_ref_exists(repo_path: Path, ref: str) -> bool:
    """Return whether ref resolves to a commit for local CLI validation."""
    process = subprocess.run(
        ["git", "rev-parse", "--verify", f"{ref}^{{commit}}"],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    return process.returncode == 0


def git_commit_exists(repo_path: Path, sha: str) -> bool:
    """Return whether sha names a commit object for local CLI validation."""
    process = subprocess.run(
        ["git", "cat-file", "-e", f"{sha}^{{commit}}"],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    return process.returncode == 0


def is_likely_git_sha(value: str) -> bool:
    """Return whether value has the local CLI's accepted SHA spelling."""
    return bool(re.fullmatch(GIT_SHA_RE, value.strip(), re.IGNORECASE))


def repo_default_branch(repo_path: Path) -> str:
    """Return the likely default branch for a local repository replay."""
    origin_head = subprocess.run(
        ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    origin_head_value = origin_head.stdout.strip()
    if origin_head.returncode == 0 and "/" in origin_head_value:
        return origin_head_value.rsplit("/", 1)[-1]

    current_branch = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    current_branch_value = current_branch.stdout.strip()
    return current_branch_value or "main"


def repo_head_sha(repo_path: Path) -> str:
    """Return HEAD's SHA or a stable local fallback when HEAD cannot be read."""
    process = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_path,
        check=False,
        capture_output=True,
        text=True,
    )
    return process.stdout.strip() or "local-worktree"


def repo_full_name(repo_path: Path, explicit: str | None) -> str:
    """Return an explicit repo full name or a local/<directory> placeholder."""
    if explicit and explicit.strip():
        return explicit.strip()
    return f"local/{repo_path.name}"
