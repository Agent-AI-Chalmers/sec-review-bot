"""Exercise the real test bootstrap from a polluted parent process."""

import os
import shutil
import subprocess
import sys
from pathlib import Path


def test_git_environment_isolation(tmp_path: Path) -> None:
    # A nested pytest process ensures the pollution precedes the session fixture.
    shutil.copyfile(Path(__file__).with_name("conftest.py"), tmp_path / "conftest.py")
    xdg = tmp_path / "xdg"
    (xdg / "git").mkdir(parents=True)
    (xdg / "git" / "attributes").write_text("* text eol=crlf\n", encoding="utf-8")
    config = tmp_path / "user.gitconfig"
    config.write_text(
        "[core]\n\tautocrlf = true\n[commit]\n\tgpgsign = true\n",
        encoding="utf-8",
    )
    shutil.copyfile(
        Path(__file__).parent / "fixtures" / "git_environment_probe.py",
        tmp_path / "test_probe.py",
    )
    env = dict(os.environ)
    env.update(
        XDG_CONFIG_HOME=str(xdg),
        GIT_CONFIG_GLOBAL=str(config),
        GIT_DIR=str(tmp_path / "nonexistent.git"),
        GIT_CONFIG_COUNT="1",
        GIT_CONFIG_KEY_0="core.autocrlf",
        GIT_CONFIG_VALUE_0="true",
    )
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "test_probe.py"],
        cwd=tmp_path,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
