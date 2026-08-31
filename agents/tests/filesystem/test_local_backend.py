from collections.abc import Mapping
from pathlib import Path
from unittest.mock import patch

import pytest
from deepagents.backends import FilesystemBackend

from sec_review_agents.filesystem.limits import (
    FilesystemLimits,
    default_filesystem_limits,
)
from sec_review_agents.filesystem.local_backend import LocalFilesystemBackend


def make_backend(
    root: Path,
    limits: FilesystemLimits,
    *,
    writable: bool = True,
) -> LocalFilesystemBackend:
    return LocalFilesystemBackend(
        root,
        limits=limits,
        writable=writable,
    )


def _match_paths(matches: object) -> list[object]:
    if not isinstance(matches, list):
        return []
    return [match.get("path") for match in matches if isinstance(match, Mapping)]


def test_limits_reject_non_positive_values() -> None:
    with pytest.raises(ValueError):
        FilesystemLimits(glob_max_results=0)

    with pytest.raises(ValueError):
        FilesystemLimits(grep_max_seconds=-0.1)

    with pytest.raises(ValueError):
        FilesystemLimits(glob_max_seconds=float("nan"))

    with pytest.raises(ValueError):
        FilesystemLimits(grep_max_seconds=float("inf"))


def test_default_limits_parse_fractional_seconds_from_env() -> None:
    with patch.dict(
        "os.environ",
        {
            "AGENT_FILESYSTEM_GLOB_MAX_SECONDS": "0.5",
            "AGENT_FILESYSTEM_GREP_MAX_SECONDS": "1.25",
        },
    ):
        limits = default_filesystem_limits()

    assert limits.glob_max_seconds == 0.5
    assert limits.grep_max_seconds == 1.25


def test_default_limits_reject_non_finite_seconds_from_env() -> None:
    with (
        patch.dict(
            "os.environ",
            {
                "AGENT_FILESYSTEM_GLOB_MAX_SECONDS": "nan",
            },
        ),
        pytest.raises(ValueError),
    ):
        default_filesystem_limits()


def test_glob_limits_results_and_ignores_dependency_dirs(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "node_modules" / "pkg").mkdir(parents=True)
    for index in range(5):
        (tmp_path / "src" / f"file{index}.js").write_text(
            "console.log(1)\n", encoding="utf-8"
        )
    (tmp_path / "node_modules" / "pkg" / "ignored.js").write_text(
        "ignored\n", encoding="utf-8"
    )

    backend = make_backend(
        tmp_path,
        FilesystemLimits(
            glob_max_results=3,
            glob_max_seconds=10,
            glob_max_visited=100,
            ignored_dirs=frozenset({"node_modules"}),
        ),
    )

    result = backend.glob("/**/*.js", "/")

    assert result.error is not None
    assert len(result.matches or []) == 3
    paths = [item["path"] for item in result.matches or []]
    assert all(path.startswith("/src/") for path in paths)
    assert not any("node_modules" in path for path in paths)


def test_glob_returns_deterministic_order_before_limit(tmp_path: Path) -> None:
    (tmp_path / "b").mkdir()
    (tmp_path / "a").mkdir()
    (tmp_path / "b" / "z.js").write_text("z\n", encoding="utf-8")
    (tmp_path / "a" / "a.js").write_text("a\n", encoding="utf-8")
    backend = make_backend(tmp_path, FilesystemLimits(glob_max_results=1))

    result = backend.glob("/**/*.js", "/")

    assert result.error is not None
    assert [item["path"] for item in result.matches or []] == ["/a/a.js"]


def test_glob_skips_symlinked_files(tmp_path: Path) -> None:
    (tmp_path / "real.js").write_text("real\n", encoding="utf-8")
    try:
        (tmp_path / "linked.js").symlink_to(tmp_path / "real.js")
    except OSError:
        pytest.skip("symlinks are not available on this filesystem")
    backend = make_backend(tmp_path, FilesystemLimits())

    result = backend.glob("/**/*.js", "/")

    assert [item["path"] for item in result.matches or []] == ["/real.js"]


def test_read_rejects_files_over_byte_budget(tmp_path: Path) -> None:
    (tmp_path / "large.txt").write_text("x" * 64, encoding="utf-8")
    backend = make_backend(
        tmp_path,
        FilesystemLimits(read_max_bytes=16),
    )

    result = backend.read("/large.txt", offset=0, limit=10)

    assert result.error is not None
    assert "filesystem resource budget" in (result.error or "")


def test_read_rejects_invalid_line_window(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("print('ok')\n", encoding="utf-8")
    backend = make_backend(tmp_path, FilesystemLimits())

    negative_offset = backend.read("/app.py", offset=-1)
    non_positive_limit = backend.read("/app.py", limit=0)

    assert negative_offset.error == "Line offset must be non-negative"
    assert non_positive_limit.error == "Line limit must be positive"


def test_read_rejects_symlinked_files(tmp_path: Path) -> None:
    (tmp_path / "real.txt").write_text("secret\n", encoding="utf-8")
    try:
        (tmp_path / "link.txt").symlink_to(tmp_path / "real.txt")
    except OSError:
        pytest.skip("symlinks are not available on this filesystem")
    backend = make_backend(tmp_path, FilesystemLimits())

    result = backend.read("/link.txt")

    assert result.error is not None
    assert "symlink" in (result.error or "")


def test_edit_keeps_newline_tolerant_behavior(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text(
        "def main():\r\n    return 1\r\n", encoding="utf-8", newline=""
    )
    backend = make_backend(tmp_path, FilesystemLimits())

    result = backend.edit(
        "/app.py",
        "def main():\n    return 1\n",
        "def main():\n    return 2\n",
    )

    assert result.error is None
    assert result.occurrences == 1
    assert "return 2" in (tmp_path / "app.py").read_text(encoding="utf-8")


def test_edit_handles_mixed_newline_content(tmp_path: Path) -> None:
    target = tmp_path / "mixed.txt"
    target.write_bytes(b"alpha\r\nbeta\ngamma\r\n")
    backend = make_backend(tmp_path, FilesystemLimits())

    result = backend.edit(
        "/mixed.txt",
        "alpha\nbeta\n",
        "ALPHA\nBETA\n",
    )

    assert result.error is None
    assert result.occurrences == 1
    assert target.read_bytes() == b"ALPHA\r\nBETA\r\ngamma\r\n"


def test_read_only_backend_rejects_mutations(tmp_path: Path) -> None:
    backend = make_backend(
        tmp_path,
        FilesystemLimits(),
        writable=False,
    )

    write_result = backend.write("/blocked.txt", "blocked")
    edit_result = backend.edit("/blocked.txt", "old", "new")
    upload_results = backend.upload_files([("/blocked-upload.txt", b"blocked")])

    assert "Writes are not allowed" in (write_result.error or "")
    assert "Edits are not allowed" in (edit_result.error or "")
    assert len(upload_results) == 1
    assert upload_results[0].error == "permission_denied"
    assert not (tmp_path / "blocked.txt").exists()
    assert not (tmp_path / "blocked-upload.txt").exists()


def test_grep_limits_matches_and_ignores_dependency_dirs(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "vendor").mkdir()
    (tmp_path / "src" / "a.py").write_text("needle\nneedle\nneedle\n", encoding="utf-8")
    (tmp_path / "vendor" / "b.py").write_text("needle\n", encoding="utf-8")
    backend = make_backend(
        tmp_path,
        FilesystemLimits(
            grep_max_matches=2,
            grep_max_seconds=10,
            grep_max_files=100,
            ignored_dirs=frozenset({"vendor"}),
        ),
    )

    result = backend.grep("needle", path="/", glob="**/*.py")

    assert result.error is not None
    assert result.truncated
    assert len(result.matches or []) == 2
    assert all(match["path"].startswith("/src/") for match in result.matches or [])


def test_grep_max_count_can_only_tighten_local_budget(tmp_path: Path) -> None:
    (tmp_path / "target.py").write_text(
        "needle\nneedle\nneedle\n",
        encoding="utf-8",
    )
    backend = make_backend(tmp_path, FilesystemLimits(grep_max_matches=2))

    tighter_result = backend.grep("needle", path="/", max_count=1)
    wider_result = backend.grep("needle", path="/", max_count=100)

    assert tighter_result.truncated
    assert len(tighter_result.matches or []) == 1
    assert wider_result.truncated
    assert len(wider_result.matches or []) == 2


def test_grep_max_count_exact_count_is_not_truncated(tmp_path: Path) -> None:
    (tmp_path / "target.py").write_text("needle\n", encoding="utf-8")
    backend = make_backend(tmp_path, FilesystemLimits(grep_max_matches=2))

    result = backend.grep("needle", path="/", max_count=1)

    assert result.error is None
    assert not result.truncated
    assert result.matches == [{"path": "/target.py", "line": 1, "text": "needle"}]


def test_grep_context_lines_are_backend_level_only(tmp_path: Path) -> None:
    (tmp_path / "target.py").write_text(
        "before\nneedle\nafter\n",
        encoding="utf-8",
    )
    backend = make_backend(tmp_path, FilesystemLimits())

    result = backend.grep("needle", path="/", context_lines=1)

    assert result.error is None
    assert result.matches == [
        {
            "path": "/target.py",
            "line": 2,
            "text": "needle",
            "context_before": [{"line": 1, "text": "before"}],
            "context_after": [{"line": 3, "text": "after"}],
        }
    ]


def test_grep_context_lines_do_not_repeat_adjacent_matches(tmp_path: Path) -> None:
    (tmp_path / "target.py").write_text(
        "needle one\nneedle two\nplain\n",
        encoding="utf-8",
    )
    backend = make_backend(tmp_path, FilesystemLimits())

    result = backend.grep("needle", path="/", context_lines=1)

    assert result.error is None
    assert result.matches == [
        {
            "path": "/target.py",
            "line": 1,
            "text": "needle one",
            "context_before": [],
            "context_after": [],
        },
        {
            "path": "/target.py",
            "line": 2,
            "text": "needle two",
            "context_before": [],
            "context_after": [{"line": 3, "text": "plain"}],
        },
    ]


def test_grep_file_limit_counts_only_glob_matched_files(tmp_path: Path) -> None:
    for index in range(5):
        (tmp_path / f"skip{index}.txt").write_text("needle\n", encoding="utf-8")
    (tmp_path / "target.py").write_text("needle\n", encoding="utf-8")
    backend = make_backend(tmp_path, FilesystemLimits(grep_max_files=1))

    result = backend.grep("needle", path="/", glob="**/*.py")

    assert result.error is None
    assert [match["path"] for match in result.matches or []] == ["/target.py"]


def test_grep_skips_symlinked_files(tmp_path: Path) -> None:
    (tmp_path / "real.py").write_text("needle\n", encoding="utf-8")
    try:
        (tmp_path / "linked.py").symlink_to(tmp_path / "real.py")
    except OSError:
        pytest.skip("symlinks are not available on this filesystem")
    backend = make_backend(tmp_path, FilesystemLimits())

    result = backend.grep("needle", path="/", glob="**/*.py")

    assert [match["path"] for match in result.matches or []] == ["/real.py"]


def test_does_not_expose_unknown_methods(tmp_path: Path) -> None:
    backend = make_backend(tmp_path, FilesystemLimits())

    with pytest.raises(AttributeError):
        backend.dangerous_passthrough()  # type: ignore[attr-defined]  # intentional API boundary check


def test_protocol_current_methods_use_local_bounded_methods(tmp_path: Path) -> None:
    (tmp_path / "target.py").write_text("needle\n", encoding="utf-8")
    backend = make_backend(tmp_path, FilesystemLimits())

    assert isinstance(backend, FilesystemBackend)
    glob_result = backend.glob("**/*.py", "/")
    grep_result = backend.grep("needle", path="/")

    assert _match_paths(glob_result.matches or []) == ["/target.py"]
    assert _match_paths(grep_result.matches or []) == ["/target.py"]
