"""Build and decode descriptor-bound Docker transfer helper calls."""

import base64
import json
from functools import lru_cache
from pathlib import Path

_PAYLOAD_PLACEHOLDER = "__PAYLOAD_B64__"


@lru_cache(maxsize=1)
def docker_transfer_script_template() -> str:
    return (
        Path(__file__)
        .with_name("docker_transfer_script_program.py")
        .read_text(encoding="utf-8")
    )


def docker_transfer_script(
    *, operation: str, root: str, relative_parts: tuple[str, ...]
) -> str:
    payload = base64.b64encode(
        json.dumps(
            {"operation": operation, "root": root, "parts": relative_parts}
        ).encode("utf-8")
    ).decode("ascii")
    return docker_transfer_script_template().replace(_PAYLOAD_PLACEHOLDER, payload)


def docker_transfer_error(stderr: bytes) -> str:
    marker = b"SEC_REVIEW_TRANSFER_ERROR:"
    for line in stderr.splitlines():
        if line.startswith(marker):
            return line.removeprefix(marker).decode("ascii", errors="replace")
    return "invalid_path"
