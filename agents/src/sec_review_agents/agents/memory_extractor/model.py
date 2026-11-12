from pydantic import BaseModel, Field

from sec_review_agents.utils.pydantic_types import NonEmptyText


class MemoryObservationOutput(BaseModel):
    observations: list[NonEmptyText] = Field(
        description=(
            "Independent durable review lessons, each a short Markdown paragraph. "
            "Return an empty list when none qualifies. Keep related evidence for "
            "one lesson together; include multiple items only for independent lessons."
        ),
    )
