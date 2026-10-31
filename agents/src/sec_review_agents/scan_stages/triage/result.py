from pydantic import BaseModel

from sec_review_agents.agents.discovery.model import DiscoveryLocation


class TriageMetadata(BaseModel):
    """Execution mode and completed pass count for one triage stage."""

    triage_mode: str
    triage_pass_count: int
    batch_size: int | None


class TriageCounts(BaseModel):
    """Coverage totals derived from the completed workbench export."""

    input_candidate_count: int
    case_count: int
    suppressed_candidate_count: int


class TriageCase(BaseModel):
    """A retained group of discovery candidates prepared for case review.

    Anchor locations carry the discovery references; they are navigation hints,
    not a claim that triage has verified the underlying vulnerability."""

    case_id: str
    category: str
    summary: str
    evidence: list[str]
    member_candidate_ids: list[str]
    anchor_locations: list[DiscoveryLocation]


class SuppressedCandidate(BaseModel):
    """A discovery candidate deliberately excluded from case review, with its reason."""

    candidate_id: str
    reason: str
    category: str


class TriageResult(BaseModel):
    """Completed triage output shared by direct execution and Temporal.

    Cases and suppressions account for the input candidates after the workbench
    has validated coverage. JSON artifacts are projections of this model."""

    status: str
    metadata: TriageMetadata
    counts: TriageCounts
    cases: list[TriageCase]
    suppressed_candidates: list[SuppressedCandidate]
