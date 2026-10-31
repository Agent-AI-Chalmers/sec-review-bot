from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.agents.analysis.model import Narrative
from sec_review_agents.review_stages.types import Verdict


class AnalysisStageResult(BaseModel):
    """Analysis retained by review orchestration after the agent call.

    Narratives keep their validated structure for repair-target selection and
    scoring. Prompt rendering, artifacts, and public records serialize them at
    their own boundaries; they are not reinterpreted as arbitrary dictionaries
    between activities. The overall verdict remains distinct from each
    narrative's verdict.
    """

    overview: str
    narratives: list[Narrative] = Field(default_factory=list)
    verdict: Verdict | None

    model_config = ConfigDict(extra="ignore")
