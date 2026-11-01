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
    cases = [{"case_id": "a", "disposition": "drop"}]
    result = _repository_result_from_replay(
        result=original, case_results=cases, replayed_case_ids=replayed_ids
    )
    assert [item["delivery_id"] for item in result["deliveries"]] == remaining
    assert result["case_results"] == cases
    assert len(original["deliveries"]) == 3
