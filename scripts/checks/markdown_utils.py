import subprocess
from pathlib import Path


def iter_markdown_files(root: Path) -> list[Path]:
    """Return existing tracked and unignored Markdown files in a git worktree."""

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
    candidates = (root / line for line in result.stdout.splitlines() if line)
    return sorted(path for path in candidates if path.is_file())
