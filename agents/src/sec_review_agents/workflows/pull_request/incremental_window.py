import json
from pathlib import Path
from typing import Any


def load_pr_diff_metadata(incremental_window_path: Path) -> dict[str, Any]:
    changed_files_path = incremental_window_path / "changed-files.json"
    changed_files_payload = json.loads(changed_files_path.read_text(encoding="utf-8"))
    raw_files = changed_files_payload.get("files")
    if not isinstance(raw_files, list):
        raise ValueError("PR incremental changed-files.json must contain files.")

    files: list[dict[str, Any]] = []
    for item in raw_files:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        if not path:
            continue
        entry = {
            "path": path,
            "status": item.get("status"),
            "additions": item.get("additions"),
            "deletions": item.get("deletions"),
            "changes": item.get("changes"),
        }
        previous_path = item.get("previous_path")
        if isinstance(previous_path, str) and previous_path.strip():
            entry["previous_path"] = previous_path.strip()
        files.append(entry)

    return {
        "changed_file_count": len(files),
        "changed_files_path": "/incremental-window/changed-files.json",
        "incremental_patch_path": "/incremental-window/incremental.patch",
        "files": files,
    }
