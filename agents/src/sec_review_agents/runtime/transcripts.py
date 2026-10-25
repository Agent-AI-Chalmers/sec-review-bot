"""Domain-independent JSONL transcript writing and reading.

Removal updates are intentionally omitted: transcripts preserve messages once
observed and are not replayable snapshots of the current LangGraph state.
"""

import json
from collections.abc import Iterable
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from langchain_core.messages import RemoveMessage

from sec_review_agents.utils.serialization import json_safe

TRANSCRIPT_BASENAME = "transcript"
TRANSCRIPT_SUFFIX = ".jsonl"


def transcript_path(directory: Path, *, name: str = TRANSCRIPT_BASENAME) -> Path:
    normalized = str(name).strip()
    if not normalized or Path(normalized).name != normalized or Path(normalized).suffix:
        raise ValueError(f"Transcript name must be a plain file stem: {name!r}")
    return directory / f"{normalized}{TRANSCRIPT_SUFFIX}"


def remove_transcripts(paths: Iterable[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)


def _message_type(message: Any) -> str:
    message_type = getattr(message, "type", None)
    if isinstance(message_type, str) and message_type.strip():
        return message_type

    get_type = getattr(message, "get_type", None)
    if callable(get_type):
        try:
            resolved = get_type()
            if isinstance(resolved, str) and resolved.strip():
                return resolved
        except Exception:
            pass

    if isinstance(message, dict):
        value = message.get("type") or message.get("role")
        if isinstance(value, str) and value.strip():
            return value

    return "unknown"


def serialize_agent_message(message: Any, *, message_id: str) -> dict:
    if isinstance(message, dict):
        serialized = {
            "type": _message_type(message),
            "id": message_id,
            "name": message.get("name"),
            "content": json_safe(message.get("content")),
            "additional_kwargs": json_safe(message.get("additional_kwargs", {})),
            "response_metadata": json_safe(message.get("response_metadata", {})),
            "tool_calls": json_safe(message.get("tool_calls", [])),
            "invalid_tool_calls": json_safe(message.get("invalid_tool_calls", [])),
            "tool_call_chunks": json_safe(message.get("tool_call_chunks", [])),
            "usage_metadata": json_safe(message.get("usage_metadata")),
        }
        # Tool linkage belongs only on tool results; null fields on every other
        # message would make the append-only artifact noisier without adding data.
        if serialized["type"] == "tool":
            serialized.update(
                {
                    "tool_call_id": message.get("tool_call_id"),
                    "status": message.get("status"),
                    "artifact": json_safe(message.get("artifact")),
                }
            )
        return serialized

    serialized = {
        "type": _message_type(message),
        "id": message_id,
        "name": getattr(message, "name", None),
        "content": json_safe(getattr(message, "content", None)),
        "additional_kwargs": json_safe(getattr(message, "additional_kwargs", {})),
        "response_metadata": json_safe(getattr(message, "response_metadata", {})),
        "tool_calls": json_safe(getattr(message, "tool_calls", [])),
        "invalid_tool_calls": json_safe(getattr(message, "invalid_tool_calls", [])),
        "tool_call_chunks": json_safe(getattr(message, "tool_call_chunks", [])),
        "usage_metadata": json_safe(getattr(message, "usage_metadata", None)),
    }
    # Keep tool-call correlation and result metadata next to the tool message.
    if serialized["type"] == "tool":
        serialized.update(
            {
                "tool_call_id": getattr(message, "tool_call_id", None),
                "status": getattr(message, "status", None),
                "artifact": json_safe(getattr(message, "artifact", None)),
            }
        )
    return serialized


def read_transcript_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if isinstance(event, dict):
            events.append(event)
    return events


def read_transcript_messages(path: Path) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for event in read_transcript_events(path):
        if event.get("event") != "message":
            continue
        message = event.get("message")
        if isinstance(message, dict):
            messages.append(message)
    return messages


class TranscriptWriter:
    def __init__(self, paths: tuple[Path, ...]) -> None:
        if not paths:
            raise ValueError("TranscriptWriter requires at least one path.")
        self.paths = paths
        self.path = self.paths[0]
        self._seq = 0
        self._seen_message_ids: set[str] = set()
        self._object_message_ids: dict[int, tuple[Any, str]] = {}
        self._lock = Lock()
        for path in self.paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")

    def _append(self, record: dict[str, Any]) -> None:
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        for path in self.paths:
            with path.open("a", encoding="utf-8") as transcript_file:
                transcript_file.write(encoded)
                transcript_file.write("\n")

    def _ensure_message_id(self, message: Any) -> str:
        if isinstance(message, dict):
            message_id = message.get("id")
            if not isinstance(message_id, str) or not message_id:
                message_id = str(uuid4())
                message["id"] = message_id
            return message_id

        message_id = getattr(message, "id", None)
        if not isinstance(message_id, str) or not message_id:
            object_id = id(message)
            cached = self._object_message_ids.get(object_id)
            if cached is not None and cached[0] is message:
                return cached[1]

            message_id = str(uuid4())
            # Persist the ID so repeated stream snapshots can be de-duplicated.
            try:
                message.id = message_id
            except AttributeError, TypeError:
                # Keep a strong reference so Python cannot reuse the object ID
                # for a different message during this writer's lifetime.
                self._object_message_ids[object_id] = (message, message_id)
        return message_id

    def write_messages(self, messages: list | None) -> None:
        if messages is None:
            return
        with self._lock:
            for message in messages:
                if isinstance(message, RemoveMessage):
                    continue
                message_id = self._ensure_message_id(message)
                if message_id in self._seen_message_ids:
                    continue
                self._seen_message_ids.add(message_id)
                self._seq += 1
                self._append(
                    {
                        "seq": self._seq,
                        "event": "message",
                        "message": serialize_agent_message(
                            message,
                            message_id=message_id,
                        ),
                    }
                )


__all__ = [
    "TRANSCRIPT_BASENAME",
    "TRANSCRIPT_SUFFIX",
    "TranscriptWriter",
    "read_transcript_events",
    "read_transcript_messages",
    "remove_transcripts",
    "transcript_path",
]
