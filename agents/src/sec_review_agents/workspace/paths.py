def _normalize_repository_path(normalized: str, original: str | None) -> str:
    """Shared tail: split, run escape checks, rejoin.

    ``normalized`` is already slash-separated and prefix-stripped by the caller.
    """
    parts = [part for part in normalized.split("/") if part]
    if any(part == ".." for part in parts):
        raise ValueError(f"Workspace path must not escape the workspace: {original}")
    if ".git" in parts:
        raise ValueError(f"Workspace path must not target .git: {original}")
    return "/".join(parts)


def normalize_declared_file_path(file_path: str | None) -> str:
    """Normalize an agent-declared repository-relative path.

    Strips only the absolute ``/workspace`` mount prefix, because that spelling is
    an unambiguous workspace-root reference (a repository-relative path never
    starts with ``/``). The bare ``/workspace``/``workspace`` mount root is not a
    repository file. A relative ``workspace/`` prefix is left intact: it may be a
    real top-level ``workspace/`` directory, and guessing would silently retarget
    the repair. Likewise ``a/``/``b/`` are real path segments, not git diff prefixes.
    """

    raw_value = str(file_path or "").strip()
    if not raw_value:
        return ""

    normalized = raw_value.replace("\\", "/")

    if normalized in {"/workspace", "workspace"}:
        return ""

    normalized = normalized.removeprefix("/workspace/")

    return _normalize_repository_path(normalized, file_path)
