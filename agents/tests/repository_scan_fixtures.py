from sec_review_agents.scan_stages.discovery.result import (
    DiscoveryCounts,
    DiscoveryMetadata,
    DiscoveryResult,
)
from sec_review_agents.scan_stages.triage.result import (
    TriageCase,
    TriageCounts,
    TriageMetadata,
    TriageResult,
)
from sec_review_agents.workflows.repository.scan_result import RepositoryScanResult


def scan_result_fixture(
    *,
    scannable_file_count: int = 0,
    scanned_file_count: int = 0,
    skipped_file_count: int = 0,
    candidate_count: int = 0,
    case_count: int = 0,
    suppressed_candidate_count: int = 0,
    deleted_file_count: int = 0,
    deletion_review_skipped: bool = False,
) -> RepositoryScanResult:
    """Build a complete scan envelope for projection and scheduling tests.

    Counts are independent test inputs: these tests exercise the consumer of an
    aggregated scan, not discovery's responsibility to derive those counts.
    """
    return RepositoryScanResult(
        discovery_result=DiscoveryResult(
            status="completed",
            metadata=DiscoveryMetadata(
                scan_mode="full",
                discovery_concurrency=1,
                discovery_deployment_input_limit_tokens=100_000,
                discovery_chunk_target_tokens=20_000,
                discovery_chunk_target_ratio="0.2",
                discovery_chunk_hard_limit_tokens=80_000,
                discovery_chunk_strategy="test",
                discovery_chunk_count=0,
            ),
            counts=DiscoveryCounts(
                scannable_file_count=scannable_file_count,
                scanned_file_count=scanned_file_count,
                skipped_file_count=skipped_file_count,
                candidate_count=candidate_count,
            ),
            files=[],
            skipped_files=[],
            candidates=[],
        ),
        triage_result=TriageResult(
            status="completed",
            metadata=TriageMetadata(
                triage_mode="single", triage_pass_count=0, batch_size=None
            ),
            counts=TriageCounts(
                input_candidate_count=candidate_count,
                case_count=case_count,
                suppressed_candidate_count=suppressed_candidate_count,
            ),
            cases=[
                TriageCase(
                    case_id=f"case-{index}",
                    category="example",
                    summary="Example case",
                    evidence=[],
                    member_candidate_ids=[],
                    anchor_locations=[],
                )
                for index in range(case_count)
            ],
            suppressed_candidates=[],
        ),
        deleted_file_count=deleted_file_count,
        deletion_review_skipped=deletion_review_skipped,
    )
