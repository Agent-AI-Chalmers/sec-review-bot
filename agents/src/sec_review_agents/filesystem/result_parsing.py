"""Classify failures from project-owned file transfers."""

import errno
from typing import Literal

FileOperationError = Literal[
    "file_not_found",
    "permission_denied",
    "is_directory",
    "invalid_path",
]


def infer_file_operation_error(
    error_output: Exception | str | None,
) -> FileOperationError:
    """Prefer OS error codes; exception text can contain misleading filenames."""
    if isinstance(error_output, OSError):
        if error_output.errno == errno.ENOENT:
            return "file_not_found"
        if error_output.errno == errno.EISDIR:
            return "is_directory"
        if error_output.errno in {errno.EACCES, errno.EPERM, errno.EROFS}:
            return "permission_denied"
        return "invalid_path"
    normalized = str(error_output or "").lower()
    if "no such file" in normalized or "not found" in normalized:
        return "file_not_found"
    if "is a directory" in normalized:
        return "is_directory"
    if "permission denied" in normalized or "read-only file system" in normalized:
        return "permission_denied"
    return "invalid_path"
