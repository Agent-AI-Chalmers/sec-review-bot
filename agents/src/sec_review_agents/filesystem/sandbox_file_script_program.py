import base64
import fnmatch
import json
import os
import re
import stat
import sys
import time
from pathlib import PurePosixPath
from typing import Any

payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))


def emit(value):
    print(json.dumps(value))


def matches_pattern(relative_path, pattern):
    path = PurePosixPath(relative_path)
    if path.match(pattern) or fnmatch.fnmatch(relative_path, pattern):
        return True
    if pattern.startswith("**/"):
        root_pattern = pattern[3:]
        return path.match(root_pattern) or fnmatch.fnmatch(relative_path, root_pattern)
    return False


def file_info(path):
    st = os.lstat(path)
    return {
        "path": path,
        "is_dir": stat.S_ISDIR(st.st_mode),
        "size": int(st.st_size),
        "modified_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime)),
    }


def newline_variants(value, preferred_newline):
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    trailing_trimmed = normalized.rstrip("\n")

    def normalize_newlines(candidate, newline):
        return (
            candidate.replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)
        )

    candidates = [
        normalize_newlines(normalized, preferred_newline),
        normalize_newlines(normalized, "\n"),
        normalize_newlines(normalized, "\r\n"),
        normalize_newlines(trailing_trimmed, preferred_newline),
        normalize_newlines(trailing_trimmed + "\n", preferred_newline),
    ]
    deduped = []
    for candidate in candidates:
        if candidate not in deduped:
            deduped.append(candidate)
    return deduped


def infer_newline(content):
    return "\r\n" if "\r\n" in content else "\n"


def newline_flexible_pattern(value):
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return r"(?:\r\n|\r|\n)".join(re.escape(part) for part in normalized.split("\n"))


op = payload["op"]

try:
    if op == "ls":
        path = payload["path"]
        max_entries = int(payload["limits"]["ls_max_entries"])
        entries: list[dict[str, Any]] = []
        try:
            with os.scandir(path) as iterator:
                for entry in sorted(iterator, key=lambda item: item.name):
                    if len(entries) >= max_entries:
                        emit({"error": "entry_limit", "entries": entries})
                        sys.exit(0)
                    entries.append(
                        {
                            "path": os.path.join(path, entry.name),
                            "is_dir": entry.is_dir(follow_symlinks=False),
                        }
                    )
        except FileNotFoundError, NotADirectoryError, PermissionError:
            emit({"entries": []})
            sys.exit(0)
        emit({"entries": entries})
        sys.exit(0)

    if op == "read":
        path = payload["path"]
        offset = int(payload["offset"])
        limit = int(payload["limit"])
        limits = payload["limits"]
        if offset < 0:
            emit({"error": "Line offset must be non-negative"})
            sys.exit(0)
        if limit <= 0:
            emit({"error": "Line limit must be positive"})
            sys.exit(0)
        if os.path.islink(path):
            emit({"error": "symlink targets are not allowed"})
            sys.exit(0)
        if not os.path.exists(path) or not os.path.isfile(path):
            emit({"error": "file_not_found"})
            sys.exit(0)
        size = os.path.getsize(path)
        if size > int(limits["read_max_bytes"]):
            emit({"error": "read_max_bytes", "size": size})
            sys.exit(0)
        if size == 0:
            emit({"encoding": "utf-8", "content": "(empty file)"})
            sys.exit(0)
        try:
            with open(path, "r", encoding="utf-8") as text_handle:
                selected: list[str] = []
                scanned_bytes = 0
                line_count = 0
                for line in text_handle:
                    scanned_bytes += len(line.encode("utf-8", errors="ignore"))
                    if scanned_bytes > int(limits["read_max_scan_bytes"]):
                        emit({"error": "read_max_scan_bytes"})
                        sys.exit(0)
                    if line_count >= offset and len(selected) < limit:
                        selected.append(line.rstrip("\n"))
                    line_count += 1
                    if len(selected) >= limit:
                        break
        except UnicodeDecodeError:
            with open(path, "rb") as binary_handle:
                raw = binary_handle.read()
            emit(
                {"encoding": "base64", "content": base64.b64encode(raw).decode("ascii")}
            )
            sys.exit(0)
        if offset >= line_count and not selected:
            emit({"error": "offset_exceeds_length", "line_count": line_count})
            sys.exit(0)
        emit(
            {
                "encoding": "utf-8",
                "content": "\n".join(selected) if selected else "(empty file)",
            }
        )
        sys.exit(0)

    if op == "glob":
        path = payload["path"]
        pattern = payload["pattern"]
        limits = payload["limits"]
        ignored_dirs = set(limits["ignored_dirs"])
        if not os.path.exists(path) or not os.path.isdir(path):
            emit({"matches": []})
            sys.exit(0)
        started_at = time.monotonic()
        matches = []
        visited = 0
        stop_reason = None
        for root, dirs, files in os.walk(path):
            dirs[:] = sorted(name for name in dirs if name not in ignored_dirs)
            if time.monotonic() - started_at >= float(limits["glob_max_seconds"]):
                stop_reason = "time_limit"
                break
            for filename in sorted(files):
                visited += 1
                if visited > int(limits["glob_max_visited"]):
                    stop_reason = "visited_limit"
                    break
                file_path = os.path.join(root, filename)
                try:
                    st = os.lstat(file_path)
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                rel = os.path.relpath(file_path, path).replace(os.sep, "/")
                if not matches_pattern(rel, pattern):
                    continue
                matches.append(file_info(file_path))
                if len(matches) >= int(limits["glob_max_results"]):
                    stop_reason = "result_limit"
                    break
                if time.monotonic() - started_at >= float(limits["glob_max_seconds"]):
                    stop_reason = "time_limit"
                    break
            if stop_reason:
                break
        matches.sort(key=lambda item: item.get("path", ""))
        emit({"matches": matches, "stop_reason": stop_reason})
        sys.exit(0)

    if op == "grep":
        path = payload["path"]
        pattern = payload["pattern"]
        glob_pattern = payload["glob"]
        limits = payload["limits"]
        ignored_dirs = set(limits["ignored_dirs"])
        grep_max_matches = int(limits["grep_max_matches"])
        if not os.path.exists(path):
            emit({"matches": []})
            sys.exit(0)
        started_at = time.monotonic()
        matches = []
        searched_files = 0
        stop_reason = None

        def candidates():
            if os.path.isfile(path):
                yield path
                return
            for root, dirs, files in os.walk(path):
                dirs[:] = sorted(name for name in dirs if name not in ignored_dirs)
                for filename in sorted(files):
                    yield os.path.join(root, filename)

        for file_path in candidates():
            if time.monotonic() - started_at >= float(limits["grep_max_seconds"]):
                stop_reason = "time_limit"
                break
            base = path if os.path.isdir(path) else os.path.dirname(path)
            rel = os.path.relpath(file_path, base).replace(os.sep, "/")
            if not matches_pattern(rel, glob_pattern):
                continue
            try:
                st = os.lstat(file_path)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            searched_files += 1
            if searched_files > int(limits["grep_max_files"]):
                stop_reason = "file_limit"
                break
            if int(st.st_size) > int(limits["read_max_bytes"]):
                continue
            try:
                with open(file_path, "r", encoding="utf-8") as handle:
                    for line_number, line in enumerate(handle, start=1):
                        if pattern not in line:
                            continue
                        if len(matches) >= grep_max_matches:
                            stop_reason = "match_limit"
                            break
                        matches.append(
                            {
                                "path": file_path,
                                "line": line_number,
                                "text": line.rstrip("\n"),
                            }
                        )
                if stop_reason:
                    break
            except OSError, UnicodeDecodeError:
                continue
        emit({"matches": matches, "stop_reason": stop_reason})
        sys.exit(0)

    if op == "write_check":
        path = payload["path"]
        if os.path.exists(path):
            emit({"error": "file_exists"})
            sys.exit(0)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        emit({"ok": True})
        sys.exit(0)

    if op == "edit":
        path = payload["path"]
        if "old_path" in payload:
            with open(payload["old_path"], "r", encoding="utf-8", newline="") as handle:
                old = handle.read()
            with open(payload["new_path"], "r", encoding="utf-8", newline="") as handle:
                new = handle.read()
        else:
            old = payload["old"]
            new = payload["new"]
        replace_all = bool(payload["replace_all"])
        if not os.path.exists(path):
            emit({"error": "file_not_found"})
            sys.exit(0)
        if os.path.islink(path) or not os.path.isfile(path):
            emit({"error": "invalid_path"})
            sys.exit(0)
        try:
            with open(path, "r", encoding="utf-8", newline="") as handle:
                content = handle.read()
        except UnicodeDecodeError:
            emit({"error": "not_a_text_file"})
            sys.exit(0)
        preferred_newline = infer_newline(content)
        normalized_old = old.replace("\r\n", "\n").replace("\r", "\n")
        new_variants = newline_variants(new, preferred_newline)
        old_variants = newline_variants(old, preferred_newline)
        strict_old_variants = (
            [
                candidate
                for candidate in old_variants
                if candidate.endswith(("\n", "\r"))
            ]
            if normalized_old.endswith("\n")
            else old_variants
        )
        relaxed_old_variants = [
            candidate
            for candidate in old_variants
            if candidate not in strict_old_variants
        ]
        for old_candidate in strict_old_variants:
            occurrences = content.count(old_candidate)
            if occurrences == 0:
                continue
            if not replace_all and occurrences != 1:
                emit({"error": "multiple_occurrences"})
                sys.exit(0)
            updated = content.replace(
                old_candidate, new_variants[0], -1 if replace_all else 1
            )
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(updated)
            emit({"count": occurrences})
            sys.exit(0)
        pattern = newline_flexible_pattern(old)
        matches = list(re.finditer(pattern, content))
        if matches:
            if not replace_all and len(matches) != 1:
                emit({"error": "multiple_occurrences"})
                sys.exit(0)
            updated = re.sub(
                pattern,
                lambda _match: new_variants[0],
                content,
                count=0 if replace_all else 1,
            )
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(updated)
            emit({"count": len(matches)})
            sys.exit(0)
        for old_candidate in relaxed_old_variants:
            occurrences = content.count(old_candidate)
            if occurrences == 0:
                continue
            if not replace_all and occurrences != 1:
                emit({"error": "multiple_occurrences"})
                sys.exit(0)
            updated = content.replace(
                old_candidate, new_variants[0], -1 if replace_all else 1
            )
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(updated)
            emit({"count": occurrences})
            sys.exit(0)
        emit({"error": "string_not_found"})
        sys.exit(0)

    emit({"error": "unknown_operation"})
except Exception as error:
    emit({"error": "exception", "detail": str(error)})
