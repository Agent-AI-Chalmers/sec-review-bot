from pydantic import BaseModel, Field


class MemoryObservationOutput(BaseModel):
    has_observation: bool = Field(
        description="True when the trajectories contain durable reusable review experience.",
    )
    observation_markdown: str = Field(
        default="",
        description=(
            "Short Markdown observation body when has_observation is true. "
            "Use an empty string when has_observation is false."
        ),
    )
