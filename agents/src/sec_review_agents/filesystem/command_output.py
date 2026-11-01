"""Small text helpers shared by command-execution backends."""


def combine_command_output(stdout: str, stderr: str) -> str:
    """Use DeepAgents LocalShellBackend's line formatting for command output.

    Keep an empty result empty so error callers can supply their own diagnostic;
    execution responses add the upstream ``<no output>`` display placeholder.
    """
    parts: list[str] = []
    if stdout:
        parts.append(stdout)
    if stderr:
        parts.extend(f"[stderr] {line}" for line in stderr.strip().split("\n"))
    return "\n".join(parts)


def truncate_output(output: str, max_bytes: int) -> tuple[str, bool]:
    encoded = output.encode("utf-8")
    if len(encoded) <= max_bytes:
        return output, False
    return encoded[:max_bytes].decode("utf-8", errors="ignore"), True


def text_output(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
