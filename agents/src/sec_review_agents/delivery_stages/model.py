"""Delivery planning payloads kept workflow-orchestration neutral."""

from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

from sec_review_agents.workspace.file_changes import (
    FileChange,
)

# Domain types

DeliveryStrategy = Literal["single", "combined"]


# Delivery plan payload


class DeliveryEntry(BaseModel):
    """One planned delivery shared by planning and patch execution.

    Case order is preserved for patch assembly. Strategy selects reuse of one
    case patch or synthesis of several patches; it is decided by planning and
    validated here to require exactly one case for reuse, rather than inferred
    again by each consumer.
    """

    delivery_id: str
    strategy: DeliveryStrategy
    case_ids: list[str]
    reason: str

    @model_validator(mode="after")
    def validate_single_case(self) -> Self:
        if self.strategy == "single" and len(self.case_ids) != 1:
            raise ValueError("Single delivery must contain exactly one case ID.")
        return self


class DeliveryPlanningCase(BaseModel):
    """Compact case information used to batch and plan deliveries.

    Planning needs the mitigation overview and changed paths, while patch bytes
    stay in the prepared patch view. Serialize this projection only when writing
    planning artifacts or populating the agent's workbench.
    """

    case_id: str
    overview: str
    changed_files: list[str]


class DeliveryPlanningMetadata(BaseModel):
    planning_mode: Literal["single", "batched", "skipped"]
    planning_pass_count: int = Field(strict=True, ge=0)
    batch_size: int | None = Field(strict=True, gt=0)


class DeliveryPlanningCounts(BaseModel):
    input_case_count: int = Field(strict=True, ge=0)
    delivery_count: int = Field(strict=True, ge=0)
    # Skipped plans retain the reviewed inventory; completed plans omit this field.
    total_case_count: int | None = Field(
        default=None, strict=True, ge=0, exclude_if=lambda value: value is None
    )


class DeliveryPlan(BaseModel):
    """Completed or skipped planning output consumed by repository execution.

    Entries contain delivery decisions, not worker-local execution state.
    Metadata and counts describe planning; execution prepares its own patch
    inputs and concurrency separately.
    """

    status: str
    metadata: DeliveryPlanningMetadata
    counts: DeliveryPlanningCounts
    deliveries: list[DeliveryEntry]


class DeliveryCaseInput(BaseModel):
    """Review projection shared by delivery planning and execution preparation.

    Planning reads the mitigation summary and changed paths; execution reads the
    patch contents. Disposition and reason are retained for the input artifact.
    Review narratives and verification details stay with the review record:
    delivery consumes cases already selected by repository orchestration.
    """

    case_id: str
    disposition: str
    reason: str | None
    mitigation_overview: str
    mitigator_file_changes: list[FileChange]
    mitigator_patch_diff: str | None
