"""Delivery execution result payloads."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.workspace.file_changes import (
    FileChange,
)


class DeliveryExecutionResult(BaseModel):
    """Execution outcome retained across activities until delivery publication.

    Failed and empty patches remain explicit outcomes so aggregation can omit
    unpublished deliveries without losing execution status or failure details.
    """

    delivery_id: str
    status: Literal["ready", "no-changes", "failed"]
    error: str | None
    patch_diff: str
    file_changes: list[FileChange] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


__all__ = ["DeliveryExecutionResult"]
