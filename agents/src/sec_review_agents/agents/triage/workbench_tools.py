from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, model_validator

from sec_review_agents.agents.triage.workbench_state import TriageWorkbenchState


class EmptyArgs(BaseModel):
    pass


class CreateGroupArgs(BaseModel):
    kind: str | None = Field(
        default="keep",
        description="Group kind: keep or suppress.",
    )
    reason: str | None = Field(
        default=None,
        description="Required for suppress groups: evidence-based suppression reason.",
    )
    summary: str | None = Field(
        default=None,
        description="Required for keep groups: concise retained case statement.",
    )
    category: str | None = Field(
        default=None,
        description="Required for keep groups: maintainer-facing category.",
    )
    evidence: list[str] | None = Field(
        default=None,
        description="Required for keep groups: non-empty evidence facts from member item payloads.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Required for create: non-empty workbench item ids covered by this group.",
    )

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_create(self) -> CreateGroupArgs:
        _validate_create_group_args(
            operation="create_group",
            kind=self.kind,
            reason=self.reason,
            summary=self.summary,
            category=self.category,
            evidence=self.evidence,
            item_ids=self.item_ids,
        )
        return self


class UpdateGroupArgs(BaseModel):
    group_id: str = Field(description="Existing group id to update.")
    kind: str | None = Field(default=None, description="Optional new group kind.")
    reason: str | None = Field(
        default=None,
        description="Optional suppress reason update.",
    )
    summary: str | None = Field(
        default=None,
        description="Optional keep summary update.",
    )
    category: str | None = Field(
        default=None,
        description="Optional keep category update.",
    )
    evidence: list[str] | None = Field(
        default=None,
        description="Optional keep evidence replacement.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Optional full replacement of this group's workbench item ids.",
    )

    @model_validator(mode="after")
    def validate_update(self) -> UpdateGroupArgs:
        if self.kind is not None:
            _validate_group_kind(self.kind)
        return self


class DeleteGroupArgs(BaseModel):
    group_id: str = Field(description="Existing group id to delete.")


class CreateGroupSpec(BaseModel):
    kind: str | None = Field(
        default="keep",
        description="Group kind: keep or suppress.",
    )
    reason: str | None = Field(
        default=None,
        description="Required for suppress groups: evidence-based suppression reason.",
    )
    summary: str | None = Field(
        default=None,
        description="Required for keep groups: concise retained case statement.",
    )
    category: str | None = Field(
        default=None,
        description="Required for keep groups: maintainer-facing category.",
    )
    evidence: list[str] | None = Field(
        default=None,
        description="Required for keep groups: non-empty evidence facts from member item payloads.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Required for create: non-empty workbench item ids covered by this group.",
    )

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_create(self) -> CreateGroupSpec:
        _validate_create_group_args(
            operation="create_groups",
            kind=self.kind,
            reason=self.reason,
            summary=self.summary,
            category=self.category,
            evidence=self.evidence,
            item_ids=self.item_ids,
        )
        return self


class CreateGroupsArgs(BaseModel):
    groups: list[CreateGroupSpec] = Field(
        description="Complete triage groups to create in this batch."
    )


class UpdateGroupSpec(BaseModel):
    group_id: str = Field(description="Existing group id to update.")
    kind: str | None = Field(default=None, description="Optional new group kind.")
    reason: str | None = Field(
        default=None,
        description="Optional suppress reason update.",
    )
    summary: str | None = Field(
        default=None,
        description="Optional keep summary update.",
    )
    category: str | None = Field(
        default=None,
        description="Optional keep category update.",
    )
    evidence: list[str] | None = Field(
        default=None,
        description="Optional keep evidence replacement.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Optional full replacement of this group's workbench item ids.",
    )

    @model_validator(mode="after")
    def validate_update(self) -> UpdateGroupSpec:
        if self.kind is not None:
            _validate_group_kind(self.kind)
        return self


class UpdateGroupsArgs(BaseModel):
    groups: list[UpdateGroupSpec] = Field(
        description="Group updates to apply in this batch."
    )


class DeleteGroupsArgs(BaseModel):
    group_ids: list[str] = Field(description="Existing group ids to delete.")


def build_triage_workbench_tools(
    workbench_state: TriageWorkbenchState,
) -> list[StructuredTool]:
    def check_constraints() -> dict[str, Any]:
        """Check triage workbench constraints."""

        return workbench_state.check_constraints()

    def read_groups() -> dict[str, Any]:
        """Read the full triage group list without member item payloads."""

        return workbench_state.read_groups()

    def create_group(
        kind: str | None = "keep",
        reason: str | None = None,
        summary: str | None = None,
        category: str | None = None,
        evidence: list[str] | None = None,
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create one complete triage group."""

        return workbench_state.create_group(
            kind=kind,
            reason=reason,
            summary=summary,
            category=category,
            evidence=evidence,
            item_ids=item_ids,
        )

    def create_groups(groups: list[CreateGroupSpec]) -> dict[str, Any]:
        """Create multiple complete triage groups."""

        return workbench_state.create_groups(
            groups=[
                (
                    group.model_dump(mode="json", exclude_none=True)
                    if isinstance(group, CreateGroupSpec)
                    else group
                )
                for group in groups
            ]
        )

    def update_group(
        group_id: str,
        kind: str | None = None,
        reason: str | None = None,
        summary: str | None = None,
        category: str | None = None,
        evidence: list[str] | None = None,
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """Update one triage group and return a compact mutation acknowledgement."""

        return workbench_state.update_group(
            group_id=group_id,
            kind=kind,
            reason=reason,
            summary=summary,
            category=category,
            evidence=evidence,
            item_ids=item_ids,
        )

    def update_groups(groups: list[UpdateGroupSpec]) -> dict[str, Any]:
        """Update multiple triage groups and return a compact mutation acknowledgement."""

        return workbench_state.update_groups(
            groups=[
                (
                    group.model_dump(mode="json", exclude_none=True)
                    if isinstance(group, UpdateGroupSpec)
                    else group
                )
                for group in groups
            ]
        )

    def delete_group(group_id: str) -> dict[str, Any]:
        """Delete one triage group and return compact ack plus unprocessed_item_ids."""

        return workbench_state.delete_group(group_id=group_id)

    def delete_groups(group_ids: list[str]) -> dict[str, Any]:
        """Delete multiple triage groups and return compact ack plus unprocessed_item_ids."""

        return workbench_state.delete_groups(group_ids=group_ids)

    return [
        StructuredTool.from_function(
            check_constraints,
            name="check_constraints",
            args_schema=EmptyArgs,
        ),
        StructuredTool.from_function(
            read_groups,
            name="read_groups",
            args_schema=EmptyArgs,
        ),
        StructuredTool.from_function(
            create_group,
            name="create_group",
            args_schema=CreateGroupArgs,
        ),
        StructuredTool.from_function(
            create_groups,
            name="create_groups",
            args_schema=CreateGroupsArgs,
        ),
        StructuredTool.from_function(
            update_group,
            name="update_group",
            args_schema=UpdateGroupArgs,
        ),
        StructuredTool.from_function(
            update_groups,
            name="update_groups",
            args_schema=UpdateGroupsArgs,
        ),
        StructuredTool.from_function(
            delete_group,
            name="delete_group",
            args_schema=DeleteGroupArgs,
        ),
        StructuredTool.from_function(
            delete_groups,
            name="delete_groups",
            args_schema=DeleteGroupsArgs,
        ),
    ]


def _validate_create_group_args(
    *,
    operation: str,
    kind: str | None,
    reason: str | None,
    summary: str | None,
    category: str | None,
    evidence: list[str] | None,
    item_ids: list[str] | None,
) -> None:
    if not _non_empty_strings(item_ids):
        raise ValueError(f"{operation} requires non-empty item_ids.")
    normalized_kind = str(kind or "keep").strip().lower()
    _validate_group_kind(normalized_kind)
    if normalized_kind == "keep":
        if (
            not _normalized_text(summary)
            or not _normalized_text(category)
            or not _non_empty_strings(evidence)
        ):
            raise ValueError(
                f"{operation} keep groups require summary, category, "
                "and non-empty evidence."
            )
    elif normalized_kind == "suppress" and not _normalized_text(reason):
        raise ValueError(f"{operation} suppress groups require reason.")


def _validate_group_kind(kind: str | None) -> None:
    normalized_kind = str(kind or "keep").strip().lower()
    if normalized_kind not in {"keep", "suppress"}:
        raise ValueError(f"invalid triage group kind: {normalized_kind or kind}")


def _normalized_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _non_empty_strings(values: list[str] | None) -> list[str]:
    return [
        str(value or "").strip() for value in values or [] if str(value or "").strip()
    ]


__all__ = ["build_triage_workbench_tools"]
