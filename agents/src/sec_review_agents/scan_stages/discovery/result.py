from typing import Literal

from pydantic import BaseModel

from sec_review_agents.agents.discovery.model import DiscoveryCandidate
from sec_review_agents.scan_stages.discovery.input import DiscoverySkippedFile


class DiscoveryCandidateResult(BaseModel):
    """Source-filtered candidate content with stage-assigned identity and status.

    The contained Candidate has the same shape as the agent's candidate, but
    retains only locations and snippets accepted against this chunk's source.
    Evidence may be empty when a valid location survives. The stage discards
    candidates with neither signal. grounded records both signals surviving;
    it does not establish that a snippet supports the location or security claim.
    ID and status are assigned by discovery, never requested from the model.
    """

    candidate_id: str
    candidate: DiscoveryCandidate
    grounding_status: Literal["grounded", "needs-grounding"]


class DiscoveryMetadata(BaseModel):
    scan_mode: str
    discovery_concurrency: int
    discovery_deployment_input_limit_tokens: int
    discovery_chunk_target_tokens: int
    discovery_chunk_target_ratio: str
    discovery_chunk_hard_limit_tokens: int
    discovery_chunk_strategy: str
    discovery_chunk_count: int


class DiscoveryCounts(BaseModel):
    scannable_file_count: int
    scanned_file_count: int
    skipped_file_count: int
    candidate_count: int


class DiscoveryFileResult(BaseModel):
    path: str
    language: str
    size_bytes: int
    candidate_count: int


class DiscoveryChunkResult(BaseModel):
    """A completed chunk scan, ready for deterministic stage aggregation.

    The scanner always supplies all collections, including when every file
    becomes unreadable. Candidates have already passed grounding normalization;
    raw model output must not be passed directly to the aggregator.
    """

    chunk_id: str
    file_candidates: list[DiscoveryCandidateResult]
    file_results: list[DiscoveryFileResult]
    skipped_files: list[DiscoverySkippedFile]


class DiscoveryResult(BaseModel):
    status: str
    metadata: DiscoveryMetadata
    counts: DiscoveryCounts
    files: list[DiscoveryFileResult]
    skipped_files: list[DiscoverySkippedFile]
    candidates: list[DiscoveryCandidateResult]
