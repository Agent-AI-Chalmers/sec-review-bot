from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class StagedTranscripts:
    entries: list[tuple[str, str, Path]]


class MemoryObservationOutput(BaseModel):
    has_observation: bool = Field(
        description="True when the transcripts contain durable reusable review experience.",
    )
    observation_markdown: str = Field(
        default="",
        description=(
            "Short Markdown observation body when has_observation is true. "
            "Use an empty string when has_observation is false."
        ),
    )
