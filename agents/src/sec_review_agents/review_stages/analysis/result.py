from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sec_review_agents.review_stages.types import Verdict

# Stage result payload


class AnalysisStageResult(BaseModel):
    overview: str
    narratives: list[dict[str, Any]] = Field(default_factory=list)
    verdict: Verdict | None

    model_config = ConfigDict(extra="ignore")

    @field_validator("narratives", mode="before")
    @classmethod
    def dict_narratives(cls, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]


def build_analysis_stage_result(
    *,
    overview: str,
    narratives: list[dict],
    verdict: str | None,
) -> dict[str, Any]:
    return AnalysisStageResult.model_validate(
        {
            "overview": overview,
            "narratives": narratives,
            "verdict": verdict,
        }
    ).model_dump(mode="json")
