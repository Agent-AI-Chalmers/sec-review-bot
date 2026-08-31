"""Local filesystem backend implementation for agent-visible filesystem tools."""

# Design notes for maintainers:
#
# This local backend is intentionally not a drop-in reimplementation of the
# full deepagents filesystem backend. Its job is narrower: give host fallback
# material views bounded reads, newline-tolerant edits, and explicit writable policy.
#
# We implement `glob`, `read`, `grep`, and `ls` here because their cost is not
# known until after traversal or file reads begin. Delegating to the base
# implementation first and truncating afterward would be too late for cases like
# `glob("/**/*.js", "/workspace")` over a repository with node_modules,
# generated assets, or vendor trees.
#
# We deliberately keep `write`, `edit`, and `upload_files` as mount-policy
# decisions here: writable views perform local filesystem mutations, while
# read-only views reject mutations at the same explicit backend that budgets
# reads. `edit` preserves backend-specific behavior first, then applies a local
# newline-tolerant fallback. If those operations become user-exposed at large
# scale, add explicit payload-size budgets at that layer rather than mixing
# traversal policy into write semantics.
#
# This class inherits `deepagents.backends.FilesystemBackend` to reuse its
# virtual path semantics and basic file mutations, but the bounded read/search
# behavior below is this backend's own contract. Do not replace `ls`, `read`,
# `grep`, or `glob` with `super()` calls unless you are also willing to give up
# those local resource promises.
#
# Maintenance risk: this code owns a small application-level contract, not
# deepagents' exact filesystem behavior. Upstream deepagents may change glob or
# grep semantics; when upgrading it, compare only the behaviors we rely on:
# virtual path shape, result dataclass fields, and basic glob expectations.
# Keep this module small and test the security/resource promises directly:
# bounded traversal, deterministic truncation, ignored directories, symlink
# non-traversal, and partial results with clear budget errors.

import os
import re
import stat
import time
from pathlib import Path, PurePosixPath

from deepagents.backends import FilesystemBackend
from deepagents.backends.protocol import (
    EditResult,
    FileData,
    FileInfo,
    FileUploadResponse,
    GlobResult,
    GrepMatch,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)

from sec_review_agents.filesystem.limits import (
    FilesystemLimits,
    bounded_filesystem_error,
    default_filesystem_limits,
    effective_grep_max_matches,
)
from sec_review_agents.filesystem.unix_paths import (
    matches_glob_pattern,
    normalize_glob_pattern,
)


def _normalize_newlines(value: str, newline: str = "\n") -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)


def _newline_variants(value: str, *, preferred_newline: str) -> list[str]:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    trailing_trimmed = normalized.rstrip("\n")

    candidates = [
        _normalize_newlines(normalized, preferred_newline),
        _normalize_newlines(normalized, "\n"),
        _normalize_newlines(normalized, "\r\n"),
        _normalize_newlines(trailing_trimmed, preferred_newline),
        _normalize_newlines(f"{trailing_trimmed}\n", preferred_newline),
    ]

    deduped: list[str] = []
    for candidate in candidates:
        if candidate not in deduped:
            deduped.append(candidate)
    return deduped


def _infer_newline(content: str) -> str:
    if "\r\n" in content:
        return "\r\n"
    return "\n"


def _newline_flexible_pattern(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return r"(?:\r\n|\r|\n)".join(re.escape(part) for part in normalized.split("\n"))


class LocalFilesystemBackend(FilesystemBackend):
    """Filesystem backend for a local root directory.

    Reads are resource-budgeted here. Writes follow the mount policy, and edits
    use a local newline-tolerant fallback when the base backend edit cannot
    match the requested text exactly.

    Inheriting `FilesystemBackend` makes the reused virtual path and mutation
    behavior explicit. It does not expand the agent tool surface; tests should
    target the current protocol methods instead of removed compatibility shims.

    Async methods are inherited from the protocol/base class so they keep calling
    these overridden sync methods instead of duplicating `asyncio.to_thread`
    wrappers here.
    """

    def __init__(
        self,
        root_dir: str | Path,
        limits: FilesystemLimits | None = None,
        *,
        writable: bool = True,
    ) -> None:
        self.root_dir = Path(root_dir)
        super().__init__(
            root_dir=str(self.root_dir),
            virtual_mode=True,
        )
        self.limits = limits or default_filesystem_limits()
        self.writable = writable

    def _unresolved_virtual_path(self, path: str) -> Path:
        vpath = path if path.startswith("/") else "/" + path
        if ".." in PurePosixPath(vpath).parts or vpath.startswith("~"):
            raise ValueError("Path traversal not allowed")
        return Path(self.cwd) / vpath.lstrip("/")

    def _prune_dirs(self, dirs: list[str]) -> None:
        dirs[:] = sorted(name for name in dirs if name not in self.limits.ignored_dirs)

    def _is_regular_file_no_symlink(self, file_path: Path) -> bool:
        try:
            stat_result = file_path.lstat()
        except OSError:
            return False
        return stat.S_ISREG(stat_result.st_mode)

    def _file_info(self, file_path: Path) -> FileInfo:
        stat = file_path.lstat()
        return {
            "path": self._to_virtual_path(file_path),
            "is_dir": False,
            "size": int(stat.st_size),
            "modified_at": time.strftime(
                "%Y-%m-%dT%H:%M:%S", time.localtime(stat.st_mtime)
            ),
        }

    def ls(self, path: str) -> LsResult:
        result = super().ls(path)
        entries = result.entries if isinstance(result, LsResult) else result
        if not entries or len(entries) <= self.limits.ls_max_entries:
            return result
        truncated = list(entries[: self.limits.ls_max_entries])
        return LsResult(
            error=bounded_filesystem_error(
                "ls", f"entry limit {self.limits.ls_max_entries} reached"
            ),
            entries=truncated,
        )

    def glob(self, pattern: str, path: str | None = "/") -> GlobResult:
        started_at = time.monotonic()
        normalized_pattern = normalize_glob_pattern(pattern)
        search_root = path or "/"

        try:
            search_path = self._resolve_path(search_root)
        except Exception as error:
            return GlobResult(
                error=f"Invalid glob path '{search_root}': {error}", matches=[]
            )

        if not search_path.exists() or not search_path.is_dir():
            return GlobResult(matches=[])

        matches: list[FileInfo] = []
        visited = 0
        stop_reason: str | None = None

        for root, dirs, files in os.walk(search_path):
            self._prune_dirs(dirs)
            root_path = Path(root)

            if (time.monotonic() - started_at) >= self.limits.glob_max_seconds:
                stop_reason = f"time limit {self.limits.glob_max_seconds:g}s reached"
                break

            for filename in sorted(files):
                visited += 1
                if visited > self.limits.glob_max_visited:
                    stop_reason = (
                        f"visited file limit {self.limits.glob_max_visited} reached"
                    )
                    break

                file_path = root_path / filename
                if not self._is_regular_file_no_symlink(file_path):
                    continue
                try:
                    relative_path = file_path.relative_to(search_path).as_posix()
                except ValueError:
                    continue

                if not matches_glob_pattern(relative_path, normalized_pattern):
                    continue

                try:
                    info = self._file_info(file_path)
                except OSError:
                    info = FileInfo(
                        path=self._to_virtual_path(file_path),
                        is_dir=False,
                    )
                matches.append(info)

                if len(matches) >= self.limits.glob_max_results:
                    stop_reason = f"result limit {self.limits.glob_max_results} reached"
                    break

                if (time.monotonic() - started_at) >= self.limits.glob_max_seconds:
                    stop_reason = (
                        f"time limit {self.limits.glob_max_seconds:g}s reached"
                    )
                    break

            if stop_reason is not None:
                break

        matches.sort(key=lambda item: item.get("path", ""))
        return GlobResult(
            error=(
                bounded_filesystem_error("glob", stop_reason) if stop_reason else None
            ),
            matches=matches,
        )

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        # Match line-window semantics up front; negative values otherwise produce
        # surprising slices after the file scan has already paid its cost.
        if offset < 0:
            return ReadResult(error="Line offset must be non-negative")
        if limit <= 0:
            return ReadResult(error="Line limit must be positive")

        try:
            unresolved_path = self._unresolved_virtual_path(file_path)
            resolved_path = self._resolve_path(file_path)
        except Exception as error:
            return ReadResult(error=f"Invalid read path '{file_path}': {error}")

        try:
            if unresolved_path.is_symlink():
                return ReadResult(
                    error=f"Error reading file '{file_path}': symlink targets are not allowed"
                )
        except OSError as error:
            return ReadResult(error=f"Error reading file '{file_path}': {error}")

        if not resolved_path.exists() or not resolved_path.is_file():
            return ReadResult(error=f"File '{file_path}' not found")

        try:
            size = resolved_path.stat().st_size
        except OSError as error:
            return ReadResult(error=f"Error reading file '{file_path}': {error}")

        if size > self.limits.read_max_bytes:
            return ReadResult(
                error=bounded_filesystem_error(
                    "read_file",
                    f"file size {size} bytes exceeds limit {self.limits.read_max_bytes} bytes",
                )
            )

        selected: list[str] = []
        scanned_bytes = 0
        line_count = 0
        try:
            fd = os.open(resolved_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "r", encoding="utf-8") as handle:
                for line in handle:
                    scanned_bytes += len(line.encode("utf-8", errors="ignore"))
                    if scanned_bytes > self.limits.read_max_scan_bytes:
                        return ReadResult(
                            error=bounded_filesystem_error(
                                "read_file",
                                f"scan limit {self.limits.read_max_scan_bytes} bytes reached before requested window",
                            )
                        )
                    if line_count >= offset and len(selected) < limit:
                        selected.append(line.rstrip("\n"))
                    line_count += 1
                    if len(selected) >= limit:
                        break
        except (OSError, UnicodeDecodeError) as error:
            return ReadResult(error=f"Error reading file '{file_path}': {error}")

        if offset >= line_count and not selected:
            return ReadResult(
                error=f"Line offset {offset} exceeds file length ({line_count} lines)"
            )
        if not selected:
            return ReadResult(
                file_data={"content": "(empty file)", "encoding": "utf-8"}
            )
        file_data: FileData = {"content": "\n".join(selected), "encoding": "utf-8"}
        return ReadResult(file_data=file_data)

    def grep(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        *,
        max_count: int | None = None,
        context_lines: int = 0,
    ) -> GrepResult:
        if context_lines < 0:
            msg = "context_lines must be non-negative"
            raise ValueError(msg)

        started_at = time.monotonic()
        normalized_glob = normalize_glob_pattern(glob or "**/*")
        effective_max_matches = effective_grep_max_matches(self.limits, max_count)
        try:
            base_path = self._resolve_path(path or "/")
        except Exception as error:
            return GrepResult(error=f"Invalid grep path '{path}': {error}", matches=[])

        if not base_path.exists():
            return GrepResult(matches=[])

        paths = [base_path] if base_path.is_file() else None
        matches: list[GrepMatch] = []
        searched_files = 0
        stop_reason: str | None = None

        def candidate_files():
            if paths is not None:
                yield from paths
                return
            for root, dirs, files in os.walk(base_path):
                self._prune_dirs(dirs)
                root_path = Path(root)
                for filename in sorted(files):
                    yield root_path / filename

        for file_path in candidate_files():
            if (time.monotonic() - started_at) >= self.limits.grep_max_seconds:
                stop_reason = f"time limit {self.limits.grep_max_seconds:g}s reached"
                break
            try:
                relative_path = file_path.relative_to(
                    base_path if base_path.is_dir() else base_path.parent
                ).as_posix()
            except ValueError:
                continue
            if not matches_glob_pattern(relative_path, normalized_glob):
                continue
            if not self._is_regular_file_no_symlink(file_path):
                continue
            searched_files += 1
            if searched_files > self.limits.grep_max_files:
                stop_reason = f"file limit {self.limits.grep_max_files} reached"
                break
            try:
                if file_path.lstat().st_size > self.limits.read_max_bytes:
                    continue
                fd = os.open(file_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "r", encoding="utf-8") as handle:
                    virtual_path = self._to_virtual_path(file_path)

                    def append_match(
                        line_number: int,
                        line: str,
                        _virtual_path: str = virtual_path,
                        *,
                        lines: list[str] | None = None,
                    ) -> bool:
                        if len(matches) >= effective_max_matches:
                            return True
                        match: GrepMatch = {
                            "path": _virtual_path,
                            "line": line_number,
                            "text": line.rstrip("\n"),
                        }
                        if lines is not None:
                            context_start = max(0, line_number - context_lines - 1)
                            context_end = line_number + context_lines
                            match["context_before"] = [
                                {
                                    "line": index + 1,
                                    "text": lines[index].rstrip("\n"),
                                }
                                for index in range(context_start, line_number - 1)
                                if pattern not in lines[index]
                            ]
                            match["context_after"] = [
                                {
                                    "line": index + 1,
                                    "text": lines[index].rstrip("\n"),
                                }
                                for index in range(
                                    line_number, min(len(lines), context_end)
                                )
                                if pattern not in lines[index]
                            ]
                        matches.append(match)
                        return False

                    if context_lines:
                        lines = handle.readlines()
                        for line_number, line in enumerate(lines, start=1):
                            if pattern not in line:
                                continue
                            if append_match(line_number, line, lines=lines):
                                stop_reason = (
                                    f"match limit {effective_max_matches} reached"
                                )
                                break
                    else:
                        for line_number, line in enumerate(handle, start=1):
                            if pattern not in line:
                                continue
                            if append_match(line_number, line):
                                stop_reason = (
                                    f"match limit {effective_max_matches} reached"
                                )
                                break
                if stop_reason is not None:
                    break
            except OSError, UnicodeDecodeError:
                continue

        return GrepResult(
            error=(
                bounded_filesystem_error("grep", stop_reason) if stop_reason else None
            ),
            matches=matches,
            truncated=stop_reason is not None,
        )

    def write(self, file_path: str, content: str) -> WriteResult:
        if not self.writable:
            return WriteResult(error=f"Writes are not allowed under {file_path}")
        return super().write(file_path, content)

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        if not self.writable:
            return EditResult(error=f"Edits are not allowed under {file_path}")

        initial_result: EditResult | None = None
        base_edit = super().edit

        def base_edit_result() -> EditResult:
            nonlocal initial_result
            if initial_result is None:
                initial_result = base_edit(
                    file_path=file_path,
                    old_string=old_string,
                    new_string=new_string,
                    replace_all=replace_all,
                )
            return initial_result

        contains_newline = any(
            character in f"{old_string}{new_string}" for character in "\r\n"
        )
        if not contains_newline:
            result = base_edit_result()
            if result.error is None:
                return result

        resolved_path = self._resolve_path(file_path)
        if not resolved_path.exists() or not resolved_path.is_file():
            return base_edit_result()

        try:
            fd = os.open(resolved_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(
                fd,
                "r",
                encoding="utf-8",
                newline="",
            ) as file_handle:
                content = file_handle.read()
        except (OSError, UnicodeDecodeError) as error:
            return EditResult(error=f"Error editing file '{file_path}': {error}")

        preferred_newline = _infer_newline(content)
        new_string_variants = _newline_variants(
            new_string, preferred_newline=preferred_newline
        )
        normalized_old_string = old_string.replace("\r\n", "\n").replace("\r", "\n")
        old_string_variants = _newline_variants(
            old_string, preferred_newline=preferred_newline
        )
        strict_old_string_variants = (
            [
                candidate
                for candidate in old_string_variants
                if candidate.endswith(("\n", "\r"))
            ]
            if normalized_old_string.endswith("\n")
            else old_string_variants
        )
        relaxed_old_string_variants = [
            candidate
            for candidate in old_string_variants
            if candidate not in strict_old_string_variants
        ]

        for candidate_old in strict_old_string_variants:
            occurrences = content.count(candidate_old)
            if occurrences == 0:
                continue
            if not replace_all and occurrences != 1:
                continue

            candidate_new = new_string_variants[0]
            updated_content = content.replace(
                candidate_old, candidate_new, -1 if replace_all else 1
            )

            try:
                flags = os.O_WRONLY | os.O_TRUNC
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(resolved_path, flags)
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as file_handle:
                    file_handle.write(updated_content)
                return EditResult(path=file_path, occurrences=occurrences)
            except (OSError, UnicodeEncodeError) as error:
                return EditResult(error=f"Error editing file '{file_path}': {error}")

        pattern = _newline_flexible_pattern(old_string)
        matches = list(re.finditer(pattern, content))
        if matches:
            occurrences = len(matches)
            if not replace_all and occurrences != 1:
                return base_edit_result()

            updated_content = re.sub(
                pattern,
                lambda _match: new_string_variants[0],
                content,
                count=0 if replace_all else 1,
            )
            try:
                flags = os.O_WRONLY | os.O_TRUNC
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(resolved_path, flags)
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as file_handle:
                    file_handle.write(updated_content)
                return EditResult(path=file_path, occurrences=occurrences)
            except (OSError, UnicodeEncodeError) as error:
                return EditResult(error=f"Error editing file '{file_path}': {error}")

        for candidate_old in relaxed_old_string_variants:
            occurrences = content.count(candidate_old)
            if occurrences == 0:
                continue
            if not replace_all and occurrences != 1:
                continue

            updated_content = content.replace(
                candidate_old, new_string_variants[0], -1 if replace_all else 1
            )

            try:
                flags = os.O_WRONLY | os.O_TRUNC
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                fd = os.open(resolved_path, flags)
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as file_handle:
                    file_handle.write(updated_content)
                return EditResult(path=file_path, occurrences=occurrences)
            except (OSError, UnicodeEncodeError) as error:
                return EditResult(error=f"Error editing file '{file_path}': {error}")

        return base_edit_result()

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        # Uploading bytes mutates target paths just like `write`, so read-only
        # material views must reject it even though the method is transport-shaped.
        if not self.writable:
            return [
                FileUploadResponse(
                    path=path,
                    error="permission_denied",
                )
                for path, _content in files
            ]
        return super().upload_files(files)
