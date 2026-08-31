import posixpath
from pathlib import Path
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field


class DeleteMemoryFileArgs(BaseModel):
    path: str = Field(
        description="Obsolete memory topic file to delete. Must be /memory/topics/*.md."
    )


def _resolve_deletable_memory_topic(memory_root: Path, path: str) -> Path | None:
    normalized = posixpath.normpath(path if path.startswith("/") else f"/{path}")
    topic_prefix = "/memory/topics/"
    if not normalized.startswith(topic_prefix):
        return None
    relative = normalized.removeprefix(topic_prefix)
    if not relative or "/" in relative or not relative.endswith(".md"):
        return None
    return memory_root / "topics" / relative


def build_memory_delete_file_tool(memory_root: Path) -> StructuredTool:
    resolved_memory_root = memory_root.expanduser().resolve()

    def delete_file(path: str) -> dict[str, Any]:
        """Delete an obsolete memory topic file after its content has been merged elsewhere."""

        target = _resolve_deletable_memory_topic(resolved_memory_root, path)
        if target is None:
            return {
                "ok": False,
                "error": "delete_file only allows direct /memory/topics/*.md files.",
            }
        topics_root = resolved_memory_root / "topics"
        try:
            target.relative_to(topics_root)
        except ValueError:
            return {
                "ok": False,
                "error": "Resolved path is outside /memory/topics.",
            }
        if not target.exists():
            return {
                "ok": False,
                "error": f"File not found: {path}",
            }
        if not target.is_file() and not target.is_symlink():
            return {
                "ok": False,
                "error": f"Refusing to delete non-file path: {path}",
            }
        target.unlink()
        return {
            "ok": True,
            "deleted": path,
        }

    return StructuredTool.from_function(
        delete_file,
        name="delete_file",
        args_schema=DeleteMemoryFileArgs,
    )
