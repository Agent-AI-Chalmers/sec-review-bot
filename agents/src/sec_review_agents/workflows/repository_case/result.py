from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sec_review_agents.review_stages.record import ReviewRecord


class RepositoryCaseResult(BaseModel):
    """One reviewed case carried from case execution to delivery and publication.

    Identity and delivery eligibility belong to the repository case; the nested record
    retains common review sections without requiring JSON between workflows.
    """

    case_id: str
    deliverable: bool = Field(strict=True)
    reason: str | None = None
    review_record: ReviewRecord

    model_config = ConfigDict(extra="ignore")

    @field_validator("case_id", mode="before")
    @classmethod
    def required_stripped_string(cls, value: Any) -> str:
        if isinstance(value, str) and value.strip():
            return value.strip()
        raise ValueError("a repository case result requires a non-empty value")

    @field_validator("reason", mode="before")
    @classmethod
    def stripped_string_or_none(cls, value: Any) -> str | None:
        return value.strip() if isinstance(value, str) and value.strip() else None
