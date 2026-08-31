import pytest

from sec_review_agents.workflows.review_intent import (
    REPAIR_MODE_TEST_CHANGES_ALLOWED,
    REVIEW_OBJECTIVE_AUDIT,
    require_review_intent,
)


def test_issue_review_accepts_repair_objective() -> None:
    review_intent = require_review_intent({"objective": "repair"})

    assert review_intent.objective == "repair"
    assert review_intent.repair_mode == REPAIR_MODE_TEST_CHANGES_ALLOWED


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


def test_workflow_review_intent_allows_missing_repair_mode() -> None:
    review_intent = require_review_intent({"objective": "audit"})

    assert review_intent.repair_mode == REPAIR_MODE_TEST_CHANGES_ALLOWED


def test_workflow_review_intent_accepts_repair_mode() -> None:
    review_intent = require_review_intent(
        {"objective": "audit", "repair_mode": "no-test-changes"}
    )

    assert review_intent.repair_mode == "no-test-changes"


def test_workflow_review_intent_rejects_unknown_repair_mode() -> None:
    with pytest.raises(ValueError, match="review_intent.repair_mode"):
        require_review_intent({"objective": "audit", "repair_mode": "fixtures-only"})


@pytest.mark.parametrize("repair_mode", [123, True, ["no-test-changes"]])
def test_workflow_review_intent_rejects_non_string_repair_mode(
    repair_mode: object,
) -> None:
    with pytest.raises(ValueError, match="review_intent.repair_mode"):
        require_review_intent({"objective": "audit", "repair_mode": repair_mode})
