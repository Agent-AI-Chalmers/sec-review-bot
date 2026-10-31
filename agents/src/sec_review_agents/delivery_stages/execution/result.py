"""Delivery execution result payloads."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.workspace.file_changes import DeletedFileChange, UpsertFileChange


class DeliveryExecutionResult(BaseModel):
    """Execution outcome retained across activities until delivery publication.

    Failed and empty patches remain explicit outcomes so aggregation can omit
    unpublished deliveries without losing execution status or failure details.
    """

    delivery_id: str
    status: Literal["ready", "no-changes", "failed"]
    error: str | None
    patch_diff: str
    file_changes: list[DeletedFileChange | UpsertFileChange] = Field(
        default_factory=list
    )

    model_config = ConfigDict(extra="ignore")


def build_delivery_execution_result(
    *,
    delivery_id: str,
    status: Literal["ready", "no-changes", "failed"],
    error: str | None,
    file_changes: list[DeletedFileChange | UpsertFileChange] | None,
    patch_diff: str,
) -> DeliveryExecutionResult:
    return DeliveryExecutionResult(
        delivery_id=delivery_id,
        status=status,
        error=error,
        patch_diff=patch_diff,
        file_changes=file_changes or [],
    )


__all__ = [
    "DeliveryExecutionResult",
    "build_delivery_execution_result",
]
