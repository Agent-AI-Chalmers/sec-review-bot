def normalize_workspace_file_path(file_path: str | None) -> str:
    raw_value = str(file_path or "").strip()

    if not raw_value:
        return ""

    normalized = raw_value.replace("\\", "/")

    if normalized in {"/workspace", "workspace"}:
        return ""

    prefixes = (
        "/workspace/",
        "workspace/",
        "a/workspace/",
        "b/workspace/",
        "a/",
        "b/",
    )

    for prefix in prefixes:
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix) :]
            break
    else:
        normalized = normalized.lstrip("/")

    parts = [part for part in normalized.split("/") if part]
    if any(part == ".." for part in parts):
        raise ValueError(f"Workspace path must not escape the workspace: {file_path}")
    if ".git" in parts:
        raise ValueError(f"Workspace path must not target .git: {file_path}")

    return "/".join(parts)
