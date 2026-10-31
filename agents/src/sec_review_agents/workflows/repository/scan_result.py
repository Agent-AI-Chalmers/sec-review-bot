from pydantic import BaseModel

from sec_review_agents.scan_stages.discovery.result import DiscoveryResult
from sec_review_agents.scan_stages.triage.result import TriageResult


class WindowDeletionSummary(BaseModel):
    """Deletion count and review coverage decision for the selected repository window.

    Discovery cannot inspect removed files. This reading is computed from the
    window itself and accompanies scan results so skipped deletion review remains
    visible even when discovery and triage succeed.
    """

    deleted_file_count: int
    deletion_review_skipped: bool


class RepositoryScanResult(BaseModel):
    """The scan's discovery, triage, and deletion decision for one repository window.

    Python orchestration carries these nested models through the Temporal
    Pydantic converter. Deletion coverage belongs to the window rather than an
    individual case, so it travels beside discovery and triage until publication.
    This is an internal workflow result; the public result projects its counts.
    """

    discovery_result: DiscoveryResult
    triage_result: TriageResult
    deleted_file_count: int
    deletion_review_skipped: bool
