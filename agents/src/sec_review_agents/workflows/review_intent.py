from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

ReviewObjective = Literal["audit", "repair"]
RepairMode = Literal["test-changes-allowed", "no-test-changes"]

REVIEW_OBJECTIVE_AUDIT: ReviewObjective = "audit"
REVIEW_OBJECTIVE_REPAIR: ReviewObjective = "repair"

REPAIR_MODE_TEST_CHANGES_ALLOWED: RepairMode = "test-changes-allowed"
REPAIR_MODE_NO_TEST_CHANGES: RepairMode = "no-test-changes"


@dataclass(frozen=True)
class ReviewIntent:
    objective: ReviewObjective
    repair_mode: RepairMode


def require_review_intent(value: object) -> ReviewIntent:
    if not isinstance(value, Mapping):
        raise ValueError("review_intent must be an object.")

    raw_objective = value.get("objective")
    if raw_objective == REVIEW_OBJECTIVE_AUDIT:
        objective = REVIEW_OBJECTIVE_AUDIT
    elif raw_objective == REVIEW_OBJECTIVE_REPAIR:
        objective = REVIEW_OBJECTIVE_REPAIR
    else:
        raise ValueError("review_intent.objective must be 'audit' or 'repair'.")

    raw_repair_mode = value.get("repair_mode")
    if raw_repair_mode is None or raw_repair_mode == REPAIR_MODE_TEST_CHANGES_ALLOWED:
        repair_mode = REPAIR_MODE_TEST_CHANGES_ALLOWED
    elif raw_repair_mode == REPAIR_MODE_NO_TEST_CHANGES:
        repair_mode = REPAIR_MODE_NO_TEST_CHANGES
    else:
        raise ValueError(
            "review_intent.repair_mode must be 'test-changes-allowed' or 'no-test-changes'."
        )
    return ReviewIntent(objective=objective, repair_mode=repair_mode)


def repair_mode_boundary_prompt_path(value: RepairMode) -> str:
    if value == REPAIR_MODE_NO_TEST_CHANGES:
        return "repair-modes/no-test-changes-boundary.md"
    return "repair-modes/test-changes-allowed-boundary.md"


__all__ = [
    "REPAIR_MODE_NO_TEST_CHANGES",
    "REPAIR_MODE_TEST_CHANGES_ALLOWED",
    "REVIEW_OBJECTIVE_AUDIT",
    "REVIEW_OBJECTIVE_REPAIR",
    "RepairMode",
    "ReviewIntent",
    "ReviewObjective",
    "repair_mode_boundary_prompt_path",
    "require_review_intent",
]
