from typing import Any, TypedDict


class DiscoveryMetadata(TypedDict):
    scan_mode: str
    discovery_concurrency: int
    discovery_chunk_target_tokens: int
    discovery_chunk_count: int


class DiscoveryCounts(TypedDict):
    scannable_file_count: int
    scanned_file_count: int
    skipped_file_count: int
    candidate_count: int


class DiscoveryFileResult(TypedDict):
    path: str
    language: str
    size_bytes: int
    candidate_count: int


class DiscoveryResult(TypedDict):
    status: str
    metadata: DiscoveryMetadata
    counts: DiscoveryCounts
    files: list[DiscoveryFileResult]
    skipped_files: list[dict[str, Any]]
    candidates: list[dict[str, Any]]
