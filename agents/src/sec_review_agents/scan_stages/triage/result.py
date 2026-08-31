from typing import Any, TypedDict


class TriageMetadata(TypedDict):
    triage_mode: str
    triage_pass_count: int
    batch_size: int | None


class TriageCounts(TypedDict):
    input_candidate_count: int
    case_count: int
    suppressed_candidate_count: int


class TriageCase(TypedDict):
    case_id: str
    category: str
    summary: str
    evidence: list[str]
    member_candidate_ids: list[str]
    anchor_locations: list[dict[str, Any]]


class SuppressedCandidate(TypedDict):
    candidate_id: str
    reason: str
    category: Any


class TriageResult(TypedDict):
    status: str
    metadata: TriageMetadata
    counts: TriageCounts
    cases: list[TriageCase]
    suppressed_candidates: list[SuppressedCandidate]
