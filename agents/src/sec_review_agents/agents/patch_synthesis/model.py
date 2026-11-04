from pydantic import BaseModel, Field

from sec_review_agents.utils.pydantic_types import NonEmptyText


class PatchSynthesisOutput(BaseModel):
    overview: NonEmptyText = Field(
        description="Brief summary of the combined repair committed to HEAD."
    )
