"""Delivery planning payloads kept workflow-orchestration neutral."""

from typing import Any, Literal

from pydantic import BaseModel

from sec_review_agents.workspace.file_changes import DeletedFileChange, UpsertFileChange

# Domain types

DeliveryStrategy = Literal["single", "combined"]


# Delivery plan payload


class DeliveryEntry(BaseModel):
    """One planned delivery shared by planning and patch execution.

    Case order is preserved for patch assembly. Strategy selects reuse of one
    case patch or synthesis of several patches; it is decided by planning and
    validated before execution rather than inferred again by each consumer.
    """

    delivery_id: str
    strategy: DeliveryStrategy
    case_ids: list[str]
    reason: str


class DeliveryPlan(BaseModel):
    """Completed or skipped planning output consumed by repository execution.

    Entries contain delivery decisions, not worker-local execution state.
    Metadata and counts describe planning; execution prepares its own patch
    inputs and concurrency separately.
    """

    status: str
    metadata: dict[str, Any]
    counts: dict[str, int]
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
    mitigator_file_changes: list[DeletedFileChange | UpsertFileChange]
    mitigator_patch_diff: str | None
