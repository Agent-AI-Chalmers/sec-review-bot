from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.agents.analysis.model import Narrative
from sec_review_agents.review_stages.types import Verdict

# Stage result payload


class AnalysisStageResult(BaseModel):
    overview: str
    narratives: list[Narrative] = Field(default_factory=list)
    verdict: Verdict | None

    model_config = ConfigDict(extra="ignore")


def build_analysis_stage_result(
    *,
    overview: str,
    narratives: list[Narrative],
    verdict: str | None,
) -> dict[str, Any]:
    return AnalysisStageResult.model_validate(
        {
            "overview": overview,
            "narratives": narratives,
            "verdict": verdict,
        }
    ).model_dump(mode="json", by_alias=True)
