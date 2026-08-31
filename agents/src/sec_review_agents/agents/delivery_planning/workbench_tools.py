from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, model_validator

from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)


class EmptyArgs(BaseModel):
    pass


# StructuredTool exposes these fields directly to the LLM; Pydantic aliases are
# not enough here because LangChain maps tool calls to function parameter names.
class CreateGroupArgs(BaseModel):
    kind: str | None = Field(
        default="delivery",
        description="Group kind. Current delivery planning only supports delivery.",
    )
    reason: str | None = Field(
        default=None,
        description="Optional concise delivery-oriented grouping reason.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Required for create: non-empty retained case ids covered by this delivery group.",
    )

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_create(self) -> CreateGroupArgs:
        _validate_create_group_args(
            operation="create_group",
            item_ids=self.item_ids,
        )
        return self


class UpdateGroupArgs(BaseModel):
    group_id: str = Field(description="Existing delivery group id to update.")
    kind: str | None = Field(
        default=None,
        description="Optional new group kind. Current delivery planning only supports delivery.",
    )
    reason: str | None = Field(
        default=None,
        description="Optional concise delivery-oriented grouping reason update.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Optional full replacement of this group's retained case ids.",
    )


class DeleteGroupArgs(BaseModel):
    group_id: str = Field(description="Existing delivery group id to delete.")


class CreateGroupSpec(BaseModel):
    kind: str | None = Field(
        default="delivery",
        description="Group kind. Current delivery planning only supports delivery.",
    )
    reason: str | None = Field(
        default=None,
        description="Optional concise delivery-oriented grouping reason.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Required for create: non-empty retained case ids covered by this delivery group.",
    )

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_create(self) -> CreateGroupSpec:
        _validate_create_group_args(
            operation="create_groups",
            item_ids=self.item_ids,
        )
        return self


class CreateGroupsArgs(BaseModel):
    groups: list[CreateGroupSpec] = Field(
        description="Complete delivery groups to create in this batch."
    )


class UpdateGroupSpec(BaseModel):
    group_id: str = Field(description="Existing delivery group id to update.")
    kind: str | None = Field(
        default=None,
        description="Optional new group kind. Current delivery planning only supports delivery.",
    )
    reason: str | None = Field(
        default=None,
        description="Optional concise delivery-oriented grouping reason update.",
    )
    item_ids: list[str] | None = Field(
        default=None,
        description="Optional full replacement of this group's retained case ids.",
    )


class UpdateGroupsArgs(BaseModel):
    groups: list[UpdateGroupSpec] = Field(
        description="Delivery group updates to apply in this batch."
    )


class DeleteGroupsArgs(BaseModel):
    group_ids: list[str] = Field(description="Existing delivery group ids to delete.")


def build_delivery_workbench_tools(
    workbench_state: DeliveryWorkbenchState,
) -> list[StructuredTool]:
    def check_constraints() -> dict[str, Any]:
        """Check delivery planning workbench constraints."""

        return workbench_state.check_constraints()

    def read_groups() -> dict[str, Any]:
        """Read the full delivery planning group list without member item payloads."""

        return workbench_state.read_groups()

    def create_group(
        kind: str | None = "delivery",
        reason: str | None = None,
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create one complete delivery planning group."""

        return workbench_state.create_group(
            kind=kind,
            reason=reason,
            item_ids=item_ids,
        )

    def create_groups(groups: list[CreateGroupSpec]) -> dict[str, Any]:
        """Create multiple complete delivery planning groups."""

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
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        """Update one delivery planning group and return a compact mutation acknowledgement."""

        return workbench_state.update_group(
            group_id=group_id,
            kind=kind,
            reason=reason,
            item_ids=item_ids,
        )

    def update_groups(groups: list[UpdateGroupSpec]) -> dict[str, Any]:
        """Update multiple delivery planning groups and return a compact mutation acknowledgement."""

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
        """Delete one delivery planning group and return compact ack plus unprocessed_item_ids."""

        return workbench_state.delete_group(group_id=group_id)

    def delete_groups(group_ids: list[str]) -> dict[str, Any]:
        """Delete multiple delivery planning groups and return compact ack plus unprocessed_item_ids."""

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


def _validate_create_group_args(*, operation: str, item_ids: list[str] | None) -> None:
    if not _non_empty_ids(item_ids):
        raise ValueError(f"{operation} requires non-empty item_ids.")


def _non_empty_ids(values: list[str] | None) -> list[str]:
    return [
        str(value or "").strip() for value in values or [] if str(value or "").strip()
    ]


__all__ = [
    "build_delivery_workbench_tools",
]
