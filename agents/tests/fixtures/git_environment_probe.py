import subprocess
from pathlib import Path


def test_git(tmp_path: Path) -> None:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.com")
    assert (
        git("check-attr", "eol", "--", "sample.txt") == "sample.txt: eol: unspecified"
    )
    (tmp_path / ".gitattributes").write_text("*.txt text eol=lf\n")
    assert git("check-attr", "eol", "--", "sample.txt") == "sample.txt: eol: lf"
    (tmp_path / "sample.txt").write_bytes(b"hello\n")
    git("add", ".")
    git("commit", "-qm", "fixture")
    (tmp_path / "sample.txt").unlink()
    git("checkout", "--", "sample.txt")
    assert (tmp_path / "sample.txt").read_bytes() == b"hello\n"
