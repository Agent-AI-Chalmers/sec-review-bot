import errno

import pytest

from sec_review_agents.filesystem.result_parsing import infer_file_operation_error


@pytest.mark.parametrize(
    ("code", "message", "filename", "expected"),
    [
        (errno.EACCES, "Permission denied", "not found.txt", "permission_denied"),
        (errno.ENOENT, "No such file", "permission denied.txt", "file_not_found"),
        (errno.EISDIR, "Is a directory", "not found", "is_directory"),
        (errno.EINVAL, "Invalid argument", "not found", "invalid_path"),
    ],
)
def test_os_error_code_overrides_filename_text(
    code, message, filename, expected
) -> None:
    assert infer_file_operation_error(OSError(code, message, filename)) == expected


def test_unstructured_error_retains_text_fallback() -> None:
    assert (
        infer_file_operation_error(RuntimeError("Permission denied"))
        == "permission_denied"
    )
