"""Directory listing for Python 3.5 containers, without scandir context managers."""

import base64
import json
import shlex

from deepagents.backends.protocol import ExecuteResponse, LsResult


def directory_listing_script(path: str) -> str:
    encoded = base64.b64encode(path.encode("utf-8")).decode("ascii")
    # Upstream BaseSandbox uses `with os.scandir`, which requires Python 3.6.
    # listdir/lstat avoids that requirement and keeps directory symlinks as files.
    return f"""import base64, json, os, stat
path = base64.b64decode('{encoded}').decode('utf-8')
entries = []
for name in os.listdir(path):
    child = os.path.join(path, name)
    entries.append({{'path': child, 'is_dir': stat.S_ISDIR(os.lstat(child).st_mode)}})
print(json.dumps(entries))
"""


def directory_listing_command(path: str) -> str:
    return "python3 -c " + shlex.quote(directory_listing_script(path))


def parse_directory_listing(result: ExecuteResponse, path: str) -> LsResult:
    if result.exit_code != 0 or result.truncated:
        return LsResult(
            error=f"Path '{path}': {result.output or 'directory listing failed'}"
        )
    try:
        entries = json.loads(result.output)
        if not isinstance(entries, list) or any(
            not isinstance(entry, dict)
            or not isinstance(entry.get("path"), str)
            or not isinstance(entry.get("is_dir"), bool)
            for entry in entries
        ):
            raise ValueError("invalid directory entries")
    except (ValueError, TypeError) as error:
        return LsResult(error=f"Path '{path}': invalid directory listing: {error}")
    return LsResult(entries=entries)
