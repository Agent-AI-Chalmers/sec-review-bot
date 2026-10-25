from typing import Literal

from pydantic import BaseModel, Field


class MemoryMaintenanceOutput(BaseModel):
    done: Literal[True] = Field(
        default=True,
        description="Set to true after maintaining the selected memory observations.",
    )
