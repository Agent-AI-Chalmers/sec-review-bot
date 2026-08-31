from collections.abc import Mapping
from typing import Any


def mapping_payload(value: Any) -> Mapping[str, Any]:
    """Coerce malformed boundary payloads to an empty mapping."""
    # Treat malformed boundary payloads as empty public-contract input.
    return value if isinstance(value, Mapping) else {}
