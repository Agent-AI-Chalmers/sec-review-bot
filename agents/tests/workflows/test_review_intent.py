import pytest

from sec_review_agents.workflows.review_intent import (
    REVIEW_OBJECTIVE_AUDIT,
    TEST_CHANGES_ALLOW,
    require_review_intent,
)


def test_issue_review_accepts_repair_objective() -> None:
    review_intent = require_review_intent({"objective": "repair"})

    assert review_intent.objective == "repair"
    assert review_intent.test_changes == TEST_CHANGES_ALLOW


def test_non_issue_workflow_rejects_repair_objective() -> None:
    review_intent = require_review_intent({"objective": "repair"})

    assert review_intent.objective != REVIEW_OBJECTIVE_AUDIT


def test_workflow_review_intent_rejects_unknown_objective() -> None:
    with pytest.raises(ValueError, match="review_intent.objective"):
        require_review_intent({"objective": "triage"})


@pytest.mark.parametrize("objective", [None, 123, True, ["audit"]])
def test_workflow_review_intent_rejects_non_string_objective(objective: object) -> None:
    with pytest.raises(ValueError, match="review_intent.objective"):
        require_review_intent({"objective": objective})


def test_workflow_review_intent_allows_missing_test_changes() -> None:
    review_intent = require_review_intent({"objective": "audit"})

    assert review_intent.test_changes == TEST_CHANGES_ALLOW


def test_workflow_review_intent_accepts_test_changes() -> None:
    review_intent = require_review_intent(
        {"objective": "audit", "test_changes": "deny"}
    )

    assert review_intent.test_changes == "deny"


def test_workflow_review_intent_rejects_unknown_test_changes() -> None:
    with pytest.raises(ValueError, match="review_intent.test_changes"):
        require_review_intent({"objective": "audit", "test_changes": "fixtures-only"})


@pytest.mark.parametrize("test_changes", [123, True, ["deny"]])
def test_workflow_review_intent_rejects_non_string_test_changes(
    test_changes: object,
) -> None:
    with pytest.raises(ValueError, match="review_intent.test_changes"):
        require_review_intent({"objective": "audit", "test_changes": test_changes})
