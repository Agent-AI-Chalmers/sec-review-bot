"""Archive publication data shared by activities and workflows.

Keep these definitions free of archive I/O and runtime imports so workflows can
use the existing archive result inside Temporal's sandbox.
"""

from dataclasses import dataclass
from typing import Any

from sec_review_agents.artifacts.reference import ArtifactReference


@dataclass(frozen=True)
class ExecutionArchive:
    reference: ArtifactReference
    unit_ids: tuple[str, ...]

    def to_artifact_storage(self) -> dict[str, Any]:
        """Project the validated publication into the public Execution response."""
        return {
            "status": "available",
            "artifact": {"kind": "execution_archive", **self.reference.as_dict()},
        }
