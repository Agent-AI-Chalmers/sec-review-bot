import pytest
from scripts.replay.repository_selected_cases import _repository_result_from_replay


@pytest.mark.parametrize(
    "replayed_ids,remaining",
    [(set(), ["a", "ab", "b"]), ({"a"}, ["b"]), ({"a", "b"}, [])],
)
def test_replay_invalidates_whole_delivery_for_successful_cases(
    replayed_ids, remaining
):
    """Failed replays leave old results intact; successful ones stale combined patches too."""
    original = {
        "scan_summary": {},
        "deletion_review_skipped": False,
        "deliveries": [
            {"delivery_id": "a", "case_ids": ["a"]},
            {"delivery_id": "ab", "case_ids": ["a", "b"]},
            {"delivery_id": "b", "case_ids": ["b"]},
        ],
    }
    cases = [{"case_id": "a", "deliverable": False}]
    result = _repository_result_from_replay(
        result=original, case_results=cases, replayed_case_ids=replayed_ids
    )
    assert [item["delivery_id"] for item in result["deliveries"]] == remaining
    assert result["case_results"] == cases
    assert len(original["deliveries"]) == 3


@pytest.mark.parametrize("case_count", [0, 2])
def test_selected_case_replay_result_matches_execution_contract(case_count):
    """Rebuilding selected cases must retain the required aggregate case count."""
    from sec_review_agents.entrypoints.execution_api_schema import (
        validate_execution_api_result,
    )
    from sec_review_agents.review_stages.record import build_review_record
    from sec_review_agents.workflows.repository_case.result import RepositoryCaseResult

    cases = [
        RepositoryCaseResult(
            case_id=f"case-{index}",
            deliverable=False,
            review_record=build_review_record(
                analysis_result=None,
                mitigation_result=None,
                verifier_result=None,
                cvss_result=None,
            ),
        ).model_dump(mode="json")
        for index in range(case_count)
    ]
    result = _repository_result_from_replay(
        result={"deletion_review_skipped": False, "case_count": 99},
        case_results=cases,
        replayed_case_ids=set(),
    )

    validate_execution_api_result(result, "repository-review")
    assert result["case_count"] == case_count
