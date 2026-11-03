import json
import posixpath
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from sec_review_agents.runtime.trajectories import parse_trajectory_jsonl


class ListTrajectoryMessagesArgs(BaseModel):
    offset: int = Field(
        default=0,
        ge=0,
        description="Zero-based message offset, not a JSONL line number.",
    )
    limit: int = Field(
        default=20, ge=1, le=50, description="Maximum messages in this page."
    )
    file_path: str = Field(
        description="Trajectory path under /trajectories, such as /trajectories/0001-analyzer-initial.jsonl."
    )


MessagePart = Literal["content", "reasoning", "tool_calls", "tool_result", "diff"]


class ReadTrajectoryMessageArgs(BaseModel):
    part: MessagePart = Field(
        default="content",
        description="content: message body; reasoning: recorded reasoning; tool_calls: requests or arguments; tool_result: body of a tool-role message; diff: recorded patch. Absent parts return an empty value.",
    )
    tool_call_id: str | None = Field(
        default=None,
        description="Only with part=tool_calls: select one call by its ID from list_trajectory_messages. Omit to read all calls in the message.",
    )
    argument: str | None = Field(
        default=None,
        description="Only with part=tool_calls and tool_call_id: select one top-level argument name from argument_names. A text argument can then be paginated.",
    )
    file_path: str = Field(
        description="Trajectory path under /trajectories, such as /trajectories/0001-analyzer-initial.jsonl."
    )
    offset: int = Field(
        default=0,
        ge=0,
        description="Zero-based character offset within the selected text value. Use the returned next_offset to continue; keep 0 for structured values.",
    )
    limit: int = Field(
        default=12000,
        ge=1,
        le=24000,
        description="Character budget for this part; oversized structured values require a narrower selection.",
    )
    seq: int = Field(
        ge=1,
        description="Original seq from list_trajectory_messages, not its list position. For tool_result, use the result message seq rather than the request seq.",
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


def _message_part(
    message: dict[str, Any],
    part: MessagePart,
    tool_call_id: str | None,
    argument: str | None,
) -> Any:
    """Select evidence before applying a budget; never expose provider/accounting fields."""
    if part != "tool_calls" and (tool_call_id is not None or argument is not None):
        raise ValueError("tool_call_id and argument apply only to tool_calls.")
    additional = message.get("additional_kwargs") or {}
    if part == "tool_calls":
        calls = [*message.get("tool_calls", []), *message.get("invalid_tool_calls", [])]
        if tool_call_id is None:
            if argument is not None:
                raise ValueError("Select tool_call_id before selecting an argument.")
            return calls
        matches = [call for call in calls if call.get("id") == tool_call_id]
        if len(matches) != 1:
            raise ValueError("No unique tool call with that ID in this message.")
        call = matches[0]
        if argument is None:
            return call
        args = call.get("args", {})
        if not isinstance(args, dict) or argument not in args:
            raise ValueError("Argument not found in the selected call.")
        return args[argument]
    if part == "diff":
        return additional.get("diff", "")
    if part == "tool_result" and message["role"] != "tool":
        raise ValueError("Select the tool result message seq, not the request seq.")
    content = message.get("content", "")
    if part == "reasoning":
        pieces = [additional.get("reasoning_content", "")]
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "thinking":
                pieces.append(block.get("thinking", ""))
            elif block.get("type") == "reasoning":
                pieces.append(block.get("reasoning", ""))
                pieces.extend(
                    item.get("text", "")
                    for item in block.get("summary", [])
                    if isinstance(item, dict)
                )
        return "\n\n".join(
            piece for piece in pieces if isinstance(piece, str) and piece
        )
    if isinstance(content, str):
        return content
    # Keep non-text evidence structured. Mirrored tool calls have their own part.
    blocks = [
        block
        for block in content
        if not (
            isinstance(block, dict)
            and (
                block.get("type") in {"thinking", "reasoning"}
                or (
                    block.get("type") in {"function_call", "tool_use"}
                    and any(
                        call.get("id") == block.get("call_id", block.get("id"))
                        and call.get("name") == block.get("name")
                        for call in message.get("tool_calls", [])
                    )
                )
            )
        )
    ]
    if all(
        isinstance(block, str)
        or isinstance(block, dict)
        and block.get("type") == "text"
        for block in blocks
    ):
        return "\n\n".join(
            block if isinstance(block, str) else block.get("text", "")
            for block in blocks
        )
    return blocks


def build_trajectory_tools(trajectory_root: Path) -> list[StructuredTool]:
    # Extraction stages immutable private copies. Cache only within this invocation,
    # with a bounded file count; never reuse evidence across extraction attempts.
    root = trajectory_root.resolve()

    @lru_cache(maxsize=8)
    def read_events(file_path: str) -> list[dict[str, Any]]:
        path = (root / posixpath.basename(file_path)).resolve()
        if path.parent != root:
            raise ValueError("Trajectory path escapes the staged directory.")
        return parse_trajectory_jsonl(path.read_text(encoding="utf-8"))

    def resolve(file_path: str) -> tuple[str | None, dict[str, Any] | None]:
        normalized = _normalize_trajectory_path(file_path)
        if normalized is None:
            return None, {
                "ok": False,
                "error": "Path must name one /trajectories/*.jsonl file.",
            }
        return normalized, None

    def list_trajectory_messages(
        file_path: str, offset: int = 0, limit: int = 20
    ) -> dict[str, Any]:
        """Locate messages in one trajectory before reading selected evidence.

        Returns previews, original seq addresses, role/source/branch labels, tool
        call IDs and argument names, and tool-result IDs/status. Previews are
        shortened navigation aids, not full evidence. Match requests and results
        by tool-call ID within the same execution branch.

        Continue with next_offset until it is null when more messages are needed;
        offsets count messages, not JSONL lines or seq values. execution_status is
        the recorded terminal status, or unknown if no terminal record is present;
        it does not establish that a security claim or tool operation succeeded.
        Use read_trajectory_message for the evidence behind a preview.
        """

        normalized, error = resolve(file_path)
        if error is not None:
            return error
        assert normalized is not None
        try:
            events = read_events(normalized)
        except OSError, ValueError:
            return {"ok": False, "error": "Unreadable or invalid transcript JSONL."}
        messages: list[dict[str, Any]] = []
        message_events = [event for event in events if event["event"] == "message"]
        for event in message_events[offset : offset + limit]:
            message = event.get("message")
            if not isinstance(message, dict):
                continue
            messages.append(
                {
                    "seq": event.get("seq"),
                    "id": message.get("id"),
                    "call_id": event.get("call_id"),
                    "run_id": event.get("run_id"),
                    "parent_ids": event.get("parent_ids", []),
                    "agent": event.get("agent"),
                    "source": event.get("source"),
                    "role": message["role"],
                    "name": message.get("name"),
                    "preview": _content_preview(message.get("content")),
                    "tool_calls": [
                        {
                            "id": call.get("id"),
                            "name": call.get("name"),
                            "argument_names": (
                                list(call["args"])
                                if isinstance(call.get("args"), dict)
                                else []
                            ),
                        }
                        for call in [
                            *message.get("tool_calls", []),
                            *message.get("invalid_tool_calls", []),
                        ]
                        if isinstance(call, dict)
                    ],
                    "tool_call_id": message.get("tool_call_id"),
                    "tool_status": message.get("status"),
                }
            )
        next_offset = offset + len(messages)
        return {
            "ok": True,
            "messages": messages,
            "execution_status": (
                events[-1].get("status", "unknown")
                if events and events[-1]["event"] == "model_calls_end"
                else "unknown"
            ),
            "total_messages": len(message_events),
            "next_offset": next_offset if next_offset < len(message_events) else None,
            "parse_errors": [],
        }

    def read_trajectory_message(
        file_path: str,
        seq: int,
        part: MessagePart = "content",
        tool_call_id: str | None = None,
        argument: str | None = None,
        offset: int = 0,
        limit: int = 12000,
    ) -> dict[str, Any]:
        """Read selected evidence from a message located with list_trajectory_messages.

        Select part first. For tool_calls, narrow to a tool_call_id and optionally
        one argument when that is all you need. tool_result reads the result
        message, not the request; its status must be considered with its body.
        Usage accounting and provider transport metadata are omitted.

        The selected value is returned in value. For long text, continue with
        next_offset while keeping the same file, seq, part and selectors. A null
        next_offset means this selection has no further pages. complete is true
        only when this response contains the entire selected value from offset 0;
        it does not certify the whole message, trajectory or successful execution.
        source_truncated=true means the recorded diff itself was truncated, even
        if all available text has been read; null provides no such declaration.

        Structured values remain intact. If one exceeds the budget, select a
        specific call/argument or increase limit within its maximum. An oversized
        nested object cannot be text-paginated. On ok=false, inspect error rather
        than treating the response as evidence; a missing part is not proof that
        the underlying activity never occurred.
        """

        normalized, error = resolve(file_path)
        if error is not None:
            return error
        assert normalized is not None
        try:
            events = read_events(normalized)
        except OSError, ValueError:
            return {"ok": False, "error": "Unreadable or invalid transcript JSONL."}
        for event in events:
            if event.get("seq") == seq and isinstance(event.get("message"), dict):
                try:
                    value = _message_part(
                        event["message"], part, tool_call_id, argument
                    )
                except ValueError as exc:
                    return {"ok": False, "error": str(exc)}
                is_text = isinstance(value, str)
                size = (
                    len(value)
                    if is_text
                    else len(json.dumps(value, ensure_ascii=False))
                )
                if not is_text and (offset != 0 or size > limit):
                    return {
                        "ok": False,
                        "error": "Structured values are not split. Select one tool_call_id and argument, or increase limit within its maximum.",
                        "total_chars": size,
                    }
                if offset > size:
                    return {
                        "ok": False,
                        "error": "Offset exceeds selected part length.",
                    }
                end = min(offset + limit, size)
                return {
                    "ok": True,
                    "seq": seq,
                    "part": part,
                    "value": value[offset:end] if is_text else value,
                    "role": event["message"]["role"],
                    "tool_call_id": event["message"].get("tool_call_id"),
                    "status": event["message"].get("status"),
                    "source_truncated": (
                        (event["message"].get("additional_kwargs") or {}).get(
                            "diff_truncated"
                        )
                        if part == "diff"
                        else None
                    ),
                    "offset": offset,
                    "total_chars": size,
                    "next_offset": end if end < size else None,
                    "complete": offset == 0 and end == size,
                    "call_id": event.get("call_id"),
                    "run_id": event.get("run_id"),
                    "parent_ids": event.get("parent_ids", []),
                    "agent": event.get("agent"),
                    "source": event.get("source"),
                    "parse_errors": [],
                }
        return {
            "ok": False,
            "error": f"No readable message with seq {seq}.",
            "parse_errors": [],
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
