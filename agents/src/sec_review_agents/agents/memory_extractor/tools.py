import json
import posixpath
from typing import Any

from deepagents.backends.protocol import BackendProtocol
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field


class ListTrajectoryMessagesArgs(BaseModel):
    file_path: str = Field(
        description="Trajectory path under /trajectories, such as /trajectories/0001-analyzer-initial.jsonl."
    )


class ReadTrajectoryMessageArgs(BaseModel):
    file_path: str = Field(
        description="Trajectory path under /trajectories, such as /trajectories/0001-analyzer-initial.jsonl."
    )
    seq: int = Field(
        ge=1,
        description="Sequence number of the complete message to read.",
    )


def _normalize_trajectory_path(file_path: str) -> str | None:
    normalized = posixpath.normpath(
        file_path if file_path.startswith("/") else f"/{file_path}"
    )
    prefix = "/trajectories/"
    if not normalized.startswith(prefix):
        return None
    relative = normalized.removeprefix(prefix)
    if not relative or "/" in relative or not relative.endswith(".jsonl"):
        return None
    return normalized


def _content_preview(content: Any, *, limit: int = 240) -> str:
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = " ".join(
            str(block.get("text") or "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    else:
        text = str(content or "")
    compact = " ".join(text.split())
    return compact[:limit] + ("..." if len(compact) > limit else "")


def _read_events(
    backend: BackendProtocol, file_path: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
    downloaded = backend.download_files([file_path])[0]
    if downloaded.error is not None or downloaded.content is None:
        return [], [], downloaded.error or "Trajectory has no readable content."

    events: list[dict[str, Any]] = []
    parse_errors: list[dict[str, Any]] = []
    for line_number, line in enumerate(
        downloaded.content.decode("utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            parse_errors.append({"line": line_number, "error": error.msg})
            continue
        if not isinstance(event, dict):
            parse_errors.append(
                {"line": line_number, "error": "event is not an object"}
            )
            continue
        events.append(event)
    return events, parse_errors, None


def build_trajectory_tools(backend: BackendProtocol) -> list[StructuredTool]:
    def resolve(file_path: str) -> tuple[str | None, dict[str, Any] | None]:
        normalized = _normalize_trajectory_path(file_path)
        if normalized is None:
            return None, {
                "ok": False,
                "error": "Path must name one /trajectories/*.jsonl file.",
            }
        return normalized, None

    def list_trajectory_messages(file_path: str) -> dict[str, Any]:
        """List message numbers and short previews from one JSONL trajectory."""

        normalized, error = resolve(file_path)
        if error is not None:
            return error
        assert normalized is not None
        events, parse_errors, read_error = _read_events(backend, normalized)
        if read_error is not None:
            return {"ok": False, "error": read_error}
        messages: list[dict[str, Any]] = []
        for event in events:
            message = event.get("message")
            if not isinstance(message, dict):
                continue
            messages.append(
                {
                    "seq": event.get("seq"),
                    "type": message.get("type"),
                    "name": message.get("name"),
                    "preview": _content_preview(message.get("content")),
                    "tool_calls": [
                        {"id": call.get("id"), "name": call.get("name")}
                        for call in message.get("tool_calls", [])
                        if isinstance(call, dict)
                    ],
                    "tool_call_id": message.get("tool_call_id"),
                    "tool_status": message.get("status"),
                    "lc_source": (message.get("additional_kwargs") or {}).get(
                        "lc_source"
                    ),
                }
            )
        return {"ok": True, "messages": messages, "parse_errors": parse_errors}

    def read_trajectory_message(file_path: str, seq: int) -> dict[str, Any]:
        """Read one complete message from a JSONL trajectory by sequence number."""

        normalized, error = resolve(file_path)
        if error is not None:
            return error
        assert normalized is not None
        events, parse_errors, read_error = _read_events(backend, normalized)
        if read_error is not None:
            return {"ok": False, "error": read_error}
        for event in events:
            if event.get("seq") == seq and isinstance(event.get("message"), dict):
                return {
                    "ok": True,
                    "seq": seq,
                    "message": event["message"],
                    "parse_errors": parse_errors,
                }
        return {
            "ok": False,
            "error": f"No readable message with seq {seq}.",
            "parse_errors": parse_errors,
        }

    return [
        StructuredTool.from_function(
            list_trajectory_messages,
            name="list_trajectory_messages",
            args_schema=ListTrajectoryMessagesArgs,
        ),
        StructuredTool.from_function(
            read_trajectory_message,
            name="read_trajectory_message",
            args_schema=ReadTrajectoryMessageArgs,
        ),
    ]
