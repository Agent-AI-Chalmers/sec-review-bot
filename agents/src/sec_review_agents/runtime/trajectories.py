"""Append-only JSONL events."""

import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from langchain_core.messages import RemoveMessage

from sec_review_agents.utils.serialization import json_safe

TRAJECTORY_BASENAME = "trajectory"
TRAJECTORY_SUFFIX = ".jsonl"


def trajectory_path(directory: Path, *, name: str = TRAJECTORY_BASENAME) -> Path:
    normalized = str(name).strip()
    if not normalized or Path(normalized).name != normalized or Path(normalized).suffix:
        raise ValueError(f"Trajectory name must be a plain file stem: {name!r}")
    return directory / f"{normalized}{TRAJECTORY_SUFFIX}"


def remove_trajectories(paths: Iterable[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)


def _message_type(message: Any) -> str:
    message_type = getattr(message, "type", None)
    if isinstance(message_type, str) and message_type.strip():
        return {"AIMessageChunk": "ai", "ToolMessageChunk": "tool"}.get(
            message_type, message_type
        )

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
            "role": {"human": "user", "ai": "assistant"}.get(
                _message_type(message), _message_type(message)
            ),
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
        if serialized["role"] == "tool":
            serialized.update(
                {
                    "tool_call_id": message.get("tool_call_id"),
                    "status": message.get("status"),
                    "artifact": json_safe(message.get("artifact")),
                }
            )
        return serialized

    serialized = {
        "role": {"human": "user", "ai": "assistant"}.get(
            _message_type(message), _message_type(message)
        ),
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
    if serialized["role"] == "tool":
        serialized.update(
            {
                "tool_call_id": getattr(message, "tool_call_id", None),
                "status": getattr(message, "status", None),
                "artifact": json_safe(getattr(message, "artifact", None)),
            }
        )
    return serialized


def validate_trajectory_event(event: Any) -> dict[str, Any]:
    """Validate one transcript record."""
    if not isinstance(event, dict):
        raise ValueError("Transcript record must be an object")
    seq = event.get("seq")
    if (
        not isinstance(seq, int)
        or isinstance(seq, bool)
        or seq < 1
        or seq > 9007199254740991
    ):
        raise ValueError("Transcript seq must be a positive integer")
    kind = event.get("event")
    if kind == "message":
        message = event.get("message")
        if not isinstance(message, dict) or "type" in message:
            raise ValueError("Transcript message must use role")
        if not isinstance(message.get("role"), str) or message["role"] not in {
            "system",
            "user",
            "assistant",
            "tool",
        }:
            raise ValueError("Invalid transcript message role")
        if not isinstance(message.get("id"), str) or not message["id"]:
            raise ValueError("Transcript message requires an ID")
        if not isinstance(message.get("content"), (str, list)):
            raise ValueError("Transcript content must be text or content blocks")
        usage = message.get("usage_metadata")
        if usage is not None:
            if not isinstance(usage, dict):
                raise ValueError("Invalid transcript usage")
            for key in ("input_tokens", "output_tokens", "total_tokens"):
                if key in usage and (
                    not isinstance(usage[key], int)
                    or isinstance(usage[key], bool)
                    or usage[key] < 0
                    or usage[key] > 9007199254740991
                ):
                    raise ValueError("Invalid transcript token count")
    elif kind == "model_calls_start":
        pass
    elif kind == "model_calls_end":
        if event.get("status") not in {"completed", "failed", "interrupted"}:
            raise ValueError("Invalid transcript execution status")
    elif kind in {"model_call_start", "model_call_end"}:
        if not isinstance(event.get("call_id"), str) or not event["call_id"]:
            raise ValueError("Transcript model call requires an ID")
        if kind == "model_call_end" and (
            not isinstance(event.get("message_id"), str) or not event["message_id"]
        ):
            raise ValueError("Transcript call end requires a response ID")
    else:
        raise ValueError("Unknown transcript event")
    metadata = event.get("metadata")
    if "metadata" in event and not isinstance(metadata, dict):
        raise ValueError("Invalid transcript metadata")
    for key in ("agent", "source", "run_id", "call_id"):
        if (
            key in event
            and event[key] is not None
            and (not isinstance(event[key], str) or not event[key])
        ):
            raise ValueError(f"Invalid transcript {key}")
    if "parent_ids" in event and (
        not isinstance(event["parent_ids"], list)
        or any(not isinstance(value, str) or not value for value in event["parent_ids"])
    ):
        raise ValueError("Invalid transcript ancestry")
    return event


def parse_trajectory_jsonl(content: str) -> list[dict[str, Any]]:
    """Read canonical records; interrupted execution is not malformed JSONL."""
    events: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}
    starts: set[str] = set()
    ends: set[str] = set()
    opened = False
    closed = False
    for line in content.splitlines():
        if not line.strip():
            continue
        event = validate_trajectory_event(json.loads(line))
        if closed or (events and event["seq"] <= events[-1]["seq"]):
            raise ValueError("Invalid transcript record order")
        kind = event["event"]
        if kind == "message":
            message_id = event["message"]["id"]
            if message_id in seen:
                raise ValueError("Duplicate transcript message ID")
            if (
                opened
                and event.get("call_id") is not None
                and event["call_id"] not in starts
            ):
                raise ValueError("Transcript response has no model call start")
            seen[message_id] = event
        elif kind == "model_calls_start":
            if opened:
                raise ValueError("Duplicate transcript recording start")
            opened = True
        elif kind == "model_calls_end":
            if not opened:
                raise ValueError("Transcript recording end has no start")
            closed = True
        elif kind in {"model_call_start", "model_call_end"}:
            if not opened:
                raise ValueError("Transcript model call has no recording start")
            call_id = event["call_id"]
            if kind == "model_call_start":
                if call_id in starts:
                    raise ValueError("Duplicate transcript model call start")
                starts.add(call_id)
            else:
                response = seen.get(event["message_id"])
                if (
                    call_id not in starts
                    or call_id in ends
                    or response is None
                    or response.get("call_id") != call_id
                ):
                    raise ValueError("Inconsistent transcript model call end")
                ends.add(call_id)
        events.append(event)
    return events


def read_trajectory_events(path: Path) -> list[dict[str, Any]]:
    return parse_trajectory_jsonl(path.read_text(encoding="utf-8"))


def read_trajectory_messages(path: Path) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for event in read_trajectory_events(path):
        if event.get("event") != "message":
            continue
        message = event.get("message")
        if isinstance(message, dict):
            messages.append(message)
    return messages


class TrajectoryWriter:
    def __init__(self, paths: tuple[Path, ...], *, agent: str | None = None) -> None:
        if not paths:
            raise ValueError("TrajectoryWriter requires at least one path.")
        self.agent = agent
        self.paths = paths
        self.path = self.paths[0]
        self._seq = 0
        self._seen_message_ids: set[str] = set()
        self._pending_messages: dict[str, tuple[Any, dict[str, Any]]] = {}
        self._object_message_ids: dict[int, tuple[Any, str]] = {}
        self._lock = Lock()
        for path in self.paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")

    def _append(self, record: dict[str, Any]) -> None:
        validate_trajectory_event(record)
        encoded = json.dumps(
            record, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        for path in self.paths:
            with path.open("a", encoding="utf-8") as trajectory_file:
                trajectory_file.write(encoded)
                trajectory_file.write("\n")

    def write_event(self, event: str, **fields: Any) -> None:
        """Append one event with a writer-local sequence number."""
        with self._lock:
            self._seq += 1
            self._append(
                {
                    "seq": self._seq,
                    "event": event,
                    **{key: json_safe(value) for key, value in fields.items()},
                }
            )

    def write_execution_event(self, event: Mapping[str, Any]) -> None:
        """Persist each response once; call ends reference its message ID."""
        kind = event["event"]
        if kind not in {
            "on_chat_model_start",
            "on_chat_model_end",
            "on_chain_start",
            "on_tool_end",
            "on_chain_end",
        }:
            return
        metadata = event.get("metadata", {})
        context = {
            "agent": metadata.get("lc_agent_name"),
            "source": metadata.get("lc_source"),
            "run_id": event["run_id"],
            "parent_ids": event.get("parent_ids", []),
            "name": event.get("name"),
            "metadata": metadata,
        }
        if kind == "on_chat_model_start":
            inputs = event["data"].get("input", {})
            batches = inputs.get("messages", []) if isinstance(inputs, Mapping) else []
            # Graph inputs arrive before the effective system prompt is known.
            # Publish that prompt first, then the branch's observed conversation.
            for messages in batches:
                leading_systems = []
                for message in messages:
                    if _message_type(message) != "system":
                        break
                    leading_systems.append(message)
                self.write_messages(leading_systems, **context)
            if context["metadata"].get("lc_source") != "summarization":
                self.flush_pending_messages(parent_ids=context["parent_ids"])
            for messages in batches:
                self.write_messages(messages, **context)
            self.write_event("model_call_start", call_id=event["run_id"], **context)
        elif kind == "on_chat_model_end":
            response = event["data"]["output"]
            self.write_messages([response], call_id=event["run_id"], **context)
            self.write_event(
                "model_call_end",
                call_id=event["run_id"],
                message_id=self._ensure_message_id(response),
                **context,
            )
        elif kind == "on_tool_end":
            output = event["data"].get("output")
            if _message_type(output) == "tool":
                self.write_messages([output], **context)
            else:
                # Delegation tools can return Command(update={"messages": ...}).
                update = getattr(output, "update", None)
                if isinstance(update, dict):
                    self.write_messages(update.get("messages"), **context)
        elif kind in {"on_chain_start", "on_chain_end"}:
            output = event["data"].get(
                "input" if kind == "on_chain_start" else "output"
            )
            if isinstance(output, Mapping):
                self.defer_messages(output.get("messages"), **context)

    def defer_messages(self, messages: list | None, **context: Any) -> None:
        """Hold graph messages until their branch's effective system is available."""
        with self._lock:
            for message in messages or []:
                if isinstance(message, RemoveMessage):
                    continue
                message_id = self._ensure_message_id(message)
                if message_id not in self._seen_message_ids:
                    self._pending_messages.setdefault(message_id, (message, context))

    def flush_pending_messages(self, *, parent_ids: list[str] | None = None) -> None:
        # A sibling Subagent must wait for its own system prompt. At termination,
        # flush everything still pending so pre-model failures retain their input.
        with self._lock:
            pending = list(self._pending_messages.values())
        for message, context in pending:
            parents = context.get("parent_ids", [])
            if parent_ids is not None and not (
                context.get("run_id") in parent_ids
                or parent_ids[: len(parents)] == parents
            ):
                continue
            self.write_messages([message], **context)

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

    def write_messages(self, messages: list | None, **context: Any) -> None:
        if messages is None:
            return
        with self._lock:
            for message in messages:
                if isinstance(message, RemoveMessage):
                    continue
                message_id = self._ensure_message_id(message)
                if message_id in self._seen_message_ids:
                    continue
                self._pending_messages.pop(message_id, None)
                self._seen_message_ids.add(message_id)
                self._seq += 1
                self._append(
                    {
                        "seq": self._seq,
                        "event": "message",
                        **{key: json_safe(value) for key, value in context.items()},
                        "agent": context.get("agent", self.agent),
                        "source": context.get("source")
                        or (
                            getattr(message, "additional_kwargs", {})
                            if not isinstance(message, dict)
                            else message.get("additional_kwargs", {})
                        ).get("lc_source"),
                        "message": serialize_agent_message(
                            message,
                            message_id=message_id,
                        ),
                    }
                )


__all__ = [
    "TRAJECTORY_BASENAME",
    "TRAJECTORY_SUFFIX",
    "TrajectoryWriter",
    "parse_trajectory_jsonl",
    "read_trajectory_events",
    "read_trajectory_messages",
    "remove_trajectories",
    "trajectory_path",
    "validate_trajectory_event",
]
