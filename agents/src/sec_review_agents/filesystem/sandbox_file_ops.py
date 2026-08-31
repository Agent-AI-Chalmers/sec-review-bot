import base64
import json
from functools import lru_cache

from sec_review_agents.filesystem.limits import (
    FilesystemLimits,
    bounded_filesystem_error,
    effective_grep_max_matches,
)

_PAYLOAD_PLACEHOLDER = "__PAYLOAD_B64__"
# Keep Docker edit transport behavior stable while owning the threshold locally.
EDIT_INLINE_MAX_BYTES = 50_000


@lru_cache(maxsize=1)
def sandbox_file_script_template() -> str:
    from pathlib import Path

    return (
        Path(__file__)
        .with_name("sandbox_file_script_program.py")
        .read_text(encoding="utf-8")
    )


def sandbox_file_script_source(*, payload_b64: str) -> str:
    return sandbox_file_script_template().replace(_PAYLOAD_PLACEHOLDER, payload_b64)


def file_operation_script(payload: dict[str, object]) -> str:
    encoded_payload = base64.b64encode(json.dumps(payload).encode("utf-8")).decode(
        "ascii"
    )
    return sandbox_file_script_source(payload_b64=encoded_payload)


def limits_payload(
    limits: FilesystemLimits,
    *,
    grep_max_count: int | None = None,
) -> dict[str, object]:
    return {
        "glob_max_results": limits.glob_max_results,
        "glob_max_seconds": limits.glob_max_seconds,
        "glob_max_visited": limits.glob_max_visited,
        "grep_max_matches": effective_grep_max_matches(limits, grep_max_count),
        "grep_max_seconds": limits.grep_max_seconds,
        "grep_max_files": limits.grep_max_files,
        "ls_max_entries": limits.ls_max_entries,
        "read_max_bytes": limits.read_max_bytes,
        "read_max_scan_bytes": limits.read_max_scan_bytes,
        "ignored_dirs": sorted(limits.ignored_dirs),
    }


def parse_file_operation_output(output: str) -> dict[str, object]:
    cleaned = output.rstrip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError, ValueError:
        detail = cleaned[:200] if cleaned else "(empty)"
        return {"error": f"unexpected server response: {detail}"}
    if not isinstance(data, dict):
        detail = cleaned[:200] if cleaned else "(empty)"
        return {"error": f"unexpected server response: {detail}"}
    return data


def bounded_stop_error(
    *,
    operation: str,
    stop_reason: object,
    limits: FilesystemLimits,
    grep_max_count: int | None = None,
) -> str | None:
    if stop_reason is None:
        return None
    effective_grep_limit = effective_grep_max_matches(limits, grep_max_count)
    reasons = {
        "entry_limit": f"entry limit {limits.ls_max_entries} reached",
        "result_limit": f"result limit {limits.glob_max_results} reached",
        "visited_limit": f"visited file limit {limits.glob_max_visited} reached",
        "time_limit": (
            f"time limit {limits.glob_max_seconds:g}s reached"
            if operation == "glob"
            else f"time limit {limits.grep_max_seconds:g}s reached"
        ),
        "file_limit": f"file limit {limits.grep_max_files} reached",
        "match_limit": f"match limit {effective_grep_limit} reached",
    }
    return bounded_filesystem_error(
        operation,
        reasons.get(str(stop_reason), str(stop_reason)),
    )


__all__ = [
    "EDIT_INLINE_MAX_BYTES",
    "bounded_stop_error",
    "file_operation_script",
    "limits_payload",
    "parse_file_operation_output",
    "sandbox_file_script_source",
    "sandbox_file_script_template",
]
