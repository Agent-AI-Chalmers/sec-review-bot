from collections.abc import Mapping
from typing import Any


def has_confirmed_repair_target(
    analysis_result: Mapping[str, Any] | None,
) -> bool:
    """Return whether analysis accepted a narrative as a confirmed repair target."""
    narratives = (analysis_result or {}).get("narratives")
    if not isinstance(narratives, list):
        return False
    return any(
        isinstance(narrative, dict)
        and narrative.get("verdict") in {"confirmed-vulnerability", "confirmed-defect"}
        for narrative in narratives
    )


__all__ = ["has_confirmed_repair_target"]
