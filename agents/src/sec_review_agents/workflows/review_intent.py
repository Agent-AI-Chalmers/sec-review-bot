from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

ReviewObjective = Literal["audit", "repair"]
TestChangesPolicy = Literal["allow", "deny"]

REVIEW_OBJECTIVE_AUDIT: ReviewObjective = "audit"
REVIEW_OBJECTIVE_REPAIR: ReviewObjective = "repair"

TEST_CHANGES_ALLOW: TestChangesPolicy = "allow"
TEST_CHANGES_DENY: TestChangesPolicy = "deny"


@dataclass(frozen=True)
class ReviewIntent:
    objective: ReviewObjective
    test_changes: TestChangesPolicy


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

    raw_test_changes = value.get("test_changes")
    if raw_test_changes is None or raw_test_changes == TEST_CHANGES_ALLOW:
        test_changes = TEST_CHANGES_ALLOW
    elif raw_test_changes == TEST_CHANGES_DENY:
        test_changes = TEST_CHANGES_DENY
    else:
        raise ValueError("review_intent.test_changes must be 'allow' or 'deny'.")
    return ReviewIntent(objective=objective, test_changes=test_changes)


def test_changes_boundary_prompt_path(value: TestChangesPolicy) -> str:
    if value == TEST_CHANGES_DENY:
        return "test-changes-policy/deny-boundary.md"
    return "test-changes-policy/allow-boundary.md"


__all__ = [
    "REVIEW_OBJECTIVE_AUDIT",
    "REVIEW_OBJECTIVE_REPAIR",
    "TEST_CHANGES_ALLOW",
    "TEST_CHANGES_DENY",
    "ReviewIntent",
    "ReviewObjective",
    "TestChangesPolicy",
    "require_review_intent",
    "test_changes_boundary_prompt_path",
]
