"""Delivery execution result payloads."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from sec_review_agents.workspace.file_changes import FileChange


class DeliveryExecutionResult(BaseModel):
    delivery_id: str
    status: str
    error: str | None
    patch_path: str | None
    patch_diff: str
    changed_files: list[str] = Field(default_factory=list)
    file_changes: list[FileChange] = Field(default_factory=list)
    applied_case_ids: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


def build_delivery_execution_result(
    *,
    delivery_id: str,
    status: str,
    error: str | None,
    changed_files: list[str],
    file_changes: list[FileChange] | None,
    patch_diff: str,
    applied_case_ids: list[str],
    patch_path: str | None,
) -> dict[str, Any]:
    return DeliveryExecutionResult.model_validate(
        {
            "delivery_id": delivery_id,
            "status": status,
            "error": error,
            "patch_path": patch_path,
            "patch_diff": patch_diff,
            "changed_files": changed_files,
            "file_changes": file_changes or [],
            "applied_case_ids": applied_case_ids,
        }
    ).model_dump(mode="json")


__all__ = [
    "DeliveryExecutionResult",
    "build_delivery_execution_result",
]
