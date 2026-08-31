from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field


@dataclass(frozen=True)
class MemoryMaintenanceObservation:
    observation_id: str
    mounted_path: str


class MemoryMaintenanceOutput(BaseModel):
    done: Literal[True] = Field(
        default=True,
        description="Set to true after maintaining the selected memory observations.",
    )
