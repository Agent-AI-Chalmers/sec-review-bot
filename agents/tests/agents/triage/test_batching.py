import pytest

from sec_review_agents.agents.discovery.model import (
    DiscoveryCandidate,
    DiscoveryLocation,
)
from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult
from sec_review_agents.scan_stages.triage.batching import triage_candidate_batches


def test_batches_preserve_path_buckets_and_candidate_order() -> None:
    candidates = [
        DiscoveryCandidateResult(
            candidate_id=candidate_id,
            candidate=DiscoveryCandidate(
                category=category,
                description="Candidate signal",
                locations=[
                    DiscoveryLocation(file=path, label="anchor") for path in paths
                ],
                evidence=[],
            ),
            grounding_status="needs-grounding",
        )
        for candidate_id, category, paths in [
            ("c", "xss", ["b.py", "a.py"]),
            ("a", "xss", ["a.py"]),
            ("b", "xss", ["a.py"]),
            ("e", "metadata", []),
            ("d", "Metadata", []),
            ("f", "xss", ["z.py"]),
        ]
    ]
    assert triage_candidate_batches(candidates, max_batch_size=2) == [
        ["a", "b"],
        ["c"],
        ["d", "e"],
        ["f"],
    ]
    assert triage_candidate_batches([], max_batch_size=2) == []
    with pytest.raises(ValueError, match="max_batch_size must be positive"):
        triage_candidate_batches(candidates, max_batch_size=0)
