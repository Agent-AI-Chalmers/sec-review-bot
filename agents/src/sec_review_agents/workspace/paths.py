import re


def validate_repository_file_path(path: str) -> str:
    """Validate an exact Git path without changing the file it identifies."""
    parts = path.split("/")
    if (
        not path
        or path != path.strip()
        or path.startswith("/")
        or re.match(r"^[A-Za-z]:", path)
        or "\\" in path
        or any(part in {"", ".", "..", ".git"} for part in parts)
        or any(character in path for character in "\x00\r\n")
    ):
        raise ValueError(f"Unsupported repository file path: {path!r}")
    return path
