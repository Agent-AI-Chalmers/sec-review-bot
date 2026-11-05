from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.review_stages.types import (
    RegressionStatus,
    ValidationLevel,
    Verdict,
)
from sec_review_agents.workspace.file_changes import (
    FileChange,
)

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
    regression: RegressionStatus
    target_claim: str
    file_changes: list[FileChange] = Field(default_factory=list)
    patch_diff: str = ""
    residual_risks: list[str] = Field(default_factory=list)
    self_check_notes: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


__all__ = ["SingleAgentFixOutcome"]
