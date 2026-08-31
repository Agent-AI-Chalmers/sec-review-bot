import subprocess
from pathlib import Path


def iter_markdown_files(root: Path) -> list[Path]:
    """Return tracked and unignored Markdown files under a git worktree."""

    result = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "*.md",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return sorted(root / line for line in result.stdout.splitlines() if line)
