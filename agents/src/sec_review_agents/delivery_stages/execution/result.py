"""Delivery execution result payloads."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.workspace.file_changes import FileChange


class DeliveryExecutionResult(BaseModel):
    delivery_id: str
    status: Literal["ready", "no-changes", "failed"]
    error: str | None
    patch_diff: str
    file_changes: list[FileChange] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def build_delivery_execution_result(
    *,
    delivery_id: str,
    status: Literal["ready", "no-changes", "failed"],
    error: str | None,
    file_changes: list[FileChange] | None,
    patch_diff: str,
) -> dict[str, Any]:
    return DeliveryExecutionResult.model_validate(
        {
            "delivery_id": delivery_id,
            "status": status,
            "error": error,
            "patch_diff": patch_diff,
            "file_changes": file_changes or [],
        }
    ).model_dump(mode="json")


__all__ = [
    "DeliveryExecutionResult",
    "build_delivery_execution_result",
]
