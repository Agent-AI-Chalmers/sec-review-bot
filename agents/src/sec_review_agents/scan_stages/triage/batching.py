from collections import defaultdict
from collections.abc import Sequence

from sec_review_agents.scan_stages.discovery.result import DiscoveryCandidateResult


def triage_candidate_batches(
    candidates: Sequence[DiscoveryCandidateResult], *, max_batch_size: int
) -> list[list[str]]:
    if max_batch_size <= 0:
        raise ValueError("max_batch_size must be positive.")
    if not candidates:
        return []

    buckets: dict[str, list[str]] = defaultdict(list)
    for candidate in candidates:
        candidate_id = candidate.candidate_id.strip()
        if not candidate_id:
            continue
        buckets[_primary_path_key(candidate)].append(candidate_id)

    ordered_buckets = sorted(
        (sorted(candidate_ids) for candidate_ids in buckets.values()),
        key=lambda item: (-len(item), item[0] if item else ""),
    )

    batches: list[list[str]] = []
    current: list[str] = []
    for bucket in ordered_buckets:
        if len(bucket) > max_batch_size:
            if current:
                batches.append(current)
                current = []
            batches.extend(
                bucket[index : index + max_batch_size]
                for index in range(0, len(bucket), max_batch_size)
            )
            continue
        if current and len(current) + len(bucket) > max_batch_size:
            batches.append(current)
            current = []
        current.extend(bucket)
    if current:
        batches.append(current)
    return batches


def _primary_path_key(candidate: DiscoveryCandidateResult) -> str:
    paths = sorted(
        {
            location.file.strip()
            for location in candidate.candidate.locations
            if location.file.strip()
        }
    )
    if paths:
        return paths[0]
    return f"__no_location_file__::{candidate.candidate.category.strip().lower()}"


__all__ = ["triage_candidate_batches"]
