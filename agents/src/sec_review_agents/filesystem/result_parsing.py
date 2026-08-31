"""Decode sandbox file-operation payloads into deepagents protocol shapes."""

from typing import Literal

from deepagents.backends.protocol import EditResult, FileInfo, GrepMatch

FileOperationError = Literal[
    "file_not_found",
    "permission_denied",
    "is_directory",
    "invalid_path",
]


def infer_file_operation_error(error_output: str | None) -> FileOperationError:
    normalized = str(error_output or "").lower()
    if "no such file" in normalized or "not found" in normalized:
        return "file_not_found"
    if "is a directory" in normalized:
        return "is_directory"
    if "permission denied" in normalized or "read-only file system" in normalized:
        return "permission_denied"
    return "invalid_path"


def object_list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def int_value(value: object, default: int) -> int:
    return value if isinstance(value, int) else default


def map_edit_error(error: str, file_path: str, old_string: str) -> EditResult:
    messages: dict[str, str] = {
        "file_not_found": f"Error: File '{file_path}' not found",
        "permission_denied": f"Error: Permission denied editing file '{file_path}'",
        "not_a_file": f"Error: '{file_path}' is not a regular file",
        "not_a_text_file": f"Error: File '{file_path}' is not a text file",
        "string_not_found": f"Error: String not found in file: '{old_string}'",
        "multiple_occurrences": (
            f"Error: String '{old_string}' appears multiple times. "
            "Use replace_all=True to replace all occurrences."
        ),
    }
    return EditResult(
        error=messages.get(error, f"Error editing file '{file_path}': {error}")
    )


def file_infos_from_payload(entries: object) -> list[FileInfo]:
    """Return valid FileInfo entries from untrusted sandbox JSON payloads."""
    result: list[FileInfo] = []
    for entry in object_list(entries):
        if not isinstance(entry, dict):
            continue
        path = entry.get("path")
        if not isinstance(path, str):
            continue
        item: FileInfo = {"path": path}
        is_dir = entry.get("is_dir")
        if isinstance(is_dir, bool):
            item["is_dir"] = is_dir
        size = entry.get("size")
        if isinstance(size, int):
            item["size"] = size
        modified_at = entry.get("modified_at")
        if isinstance(modified_at, str):
            item["modified_at"] = modified_at
        result.append(item)
    return result


def grep_matches_from_payload(matches: object) -> list[GrepMatch]:
    """Return valid GrepMatch entries from untrusted sandbox JSON payloads."""
    result: list[GrepMatch] = []
    for match in object_list(matches):
        if not isinstance(match, dict):
            continue
        path = match.get("path")
        line = match.get("line")
        text = match.get("text")
        if not isinstance(path, str) or not isinstance(line, int):
            continue
        result.append({"path": path, "line": line, "text": str(text or "")})
    return result
