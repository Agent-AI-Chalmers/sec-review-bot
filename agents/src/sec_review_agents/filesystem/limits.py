import math
from dataclasses import dataclass, field

from sec_review_agents.utils.env import env_value, float_env, int_env

DEFAULT_IGNORED_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".tox",
        ".venv",
        "venv",
        "env",
        "ENV",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "node_modules",
        "bower_components",
        "vendor",
        "dist",
        "build",
        "coverage",
        "htmlcov",
        "target",
        "out",
        ".next",
        ".nuxt",
        ".cache",
        "tmp",
        "temp",
    }
)

# One default applies to every execution-capable filesystem backend. Backend-
# specific environment variables may still override it for deployment needs.
DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000


@dataclass(frozen=True)
class FilesystemLimits:
    glob_max_results: int = 1000
    glob_max_seconds: float = 8.0
    glob_max_visited: int = 50_000
    grep_max_matches: int = 500
    grep_max_seconds: float = 8.0
    grep_max_files: int = 20_000
    ls_max_entries: int = 2000
    read_max_bytes: int = 1_000_000
    read_max_scan_bytes: int = 2_000_000
    ignored_dirs: frozenset[str] = field(default_factory=lambda: DEFAULT_IGNORED_DIRS)

    def __post_init__(self) -> None:
        int_fields = (
            "glob_max_results",
            "glob_max_visited",
            "grep_max_matches",
            "grep_max_files",
            "ls_max_entries",
            "read_max_bytes",
            "read_max_scan_bytes",
        )
        float_fields = ("glob_max_seconds", "grep_max_seconds")

        for field_name in int_fields:
            value = getattr(self, field_name)
            if not isinstance(value, int) or value <= 0:
                raise ValueError(
                    f"FilesystemLimits.{field_name} must be a positive integer."
                )

        for field_name in float_fields:
            value = getattr(self, field_name)
            if (
                not isinstance(value, int | float)
                or not math.isfinite(value)
                or value <= 0
            ):
                raise ValueError(
                    f"FilesystemLimits.{field_name} must be a positive number."
                )

        object.__setattr__(
            self,
            "ignored_dirs",
            frozenset(str(item) for item in self.ignored_dirs if str(item)),
        )


def default_filesystem_limits() -> FilesystemLimits:
    ignored_dirs = set(DEFAULT_IGNORED_DIRS)
    extra_ignored = env_value("AGENT_FILESYSTEM_EXTRA_IGNORED_DIRS")
    if extra_ignored:
        ignored_dirs.update(
            item.strip() for item in extra_ignored.split(",") if item.strip()
        )

    return FilesystemLimits(
        glob_max_results=int_env("AGENT_FILESYSTEM_GLOB_MAX_RESULTS", 1000, minimum=1),
        glob_max_seconds=float_env(
            "AGENT_FILESYSTEM_GLOB_MAX_SECONDS", 8.0, minimum=0.0
        ),
        glob_max_visited=int_env(
            "AGENT_FILESYSTEM_GLOB_MAX_VISITED", 50_000, minimum=1
        ),
        grep_max_matches=int_env("AGENT_FILESYSTEM_GREP_MAX_MATCHES", 500, minimum=1),
        grep_max_seconds=float_env(
            "AGENT_FILESYSTEM_GREP_MAX_SECONDS", 8.0, minimum=0.0
        ),
        grep_max_files=int_env("AGENT_FILESYSTEM_GREP_MAX_FILES", 20_000, minimum=1),
        ls_max_entries=int_env("AGENT_FILESYSTEM_LS_MAX_ENTRIES", 2000, minimum=1),
        read_max_bytes=int_env("AGENT_FILESYSTEM_READ_MAX_BYTES", 1_000_000, minimum=1),
        read_max_scan_bytes=int_env(
            "AGENT_FILESYSTEM_READ_MAX_SCAN_BYTES", 2_000_000, minimum=1
        ),
        ignored_dirs=frozenset(ignored_dirs),
    )


def effective_grep_max_matches(
    limits: FilesystemLimits,
    max_count: int | None,
) -> int:
    # DeepAgents exposes grep(max_count=...) as a caller preference. This
    # backend treats FilesystemLimits as the resource boundary, so callers may
    # only tighten the grep budget, never raise it above the configured limit.
    if max_count is None:
        return limits.grep_max_matches
    return max(0, min(max_count, limits.grep_max_matches))


def bounded_filesystem_error(operation: str, reason: str) -> str:
    return (
        f"{operation} stopped by filesystem resource budget: {reason}. "
        "Use a narrower path or pattern."
    )
