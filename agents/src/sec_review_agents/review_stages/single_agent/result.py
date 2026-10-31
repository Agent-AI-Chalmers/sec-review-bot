from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.review_stages.types import (
    RegressionStatus,
    ValidationLevel,
    Verdict,
)
from sec_review_agents.workspace.file_changes import DeletedFileChange, UpsertFileChange

# Workflow result payload


class SingleAgentFixOutcome(BaseModel):
    """One agent's analysis, repair and self-check retained across activities.

    This is a combined outcome rather than evidence that separate review stages
    ran. Workflow-specific projection derives the public sections from it. Application
    code converts it to JSON at publication or artifact boundaries; Temporal
    restores the model after transporting it between activities.
    """

    overview: str
    verdict: Verdict
    validation_level: ValidationLevel
    regression_status: RegressionStatus
    target_claim: str
    file_changes: list[DeletedFileChange | UpsertFileChange] = Field(
        default_factory=list
    )
    patch_diff: str = ""
    residual_risks: list[str] = Field(default_factory=list)
    self_check_notes: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def build_single_agent_fix_outcome(
    *,
    overview: str,
    verdict: str,
    validation_level: str,
    regression_status: str,
    target_claim: str,
    file_changes: Sequence[Mapping[str, Any]] | None = None,
    patch_diff: str = "",
    residual_risks: list[str] | None = None,
    self_check_notes: list[str] | None = None,
) -> SingleAgentFixOutcome:
    return SingleAgentFixOutcome.model_validate(
        {
            "overview": overview,
            "verdict": verdict,
            "validation_level": validation_level,
            "regression_status": regression_status,
            "target_claim": target_claim,
            "file_changes": file_changes or [],
            "patch_diff": patch_diff,
            "residual_risks": residual_risks or [],
            "self_check_notes": self_check_notes or [],
        }
    )


# Public exports

__all__ = [
    "SingleAgentFixOutcome",
    "build_single_agent_fix_outcome",
]
