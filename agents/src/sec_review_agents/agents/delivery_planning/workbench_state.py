import hashlib
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field, model_validator

from sec_review_agents.delivery_stages.model import DeliveryEntry, DeliveryStrategy


class _CreateGroupInput(BaseModel):
    kind: str | None = "delivery"
    reason: str | None = None
    item_ids: list[str] | None = Field(default=None)

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_create(self) -> _CreateGroupInput:
        if not _dedupe_ids(self.item_ids or []):
            raise ValueError("create_group requires non-empty item_ids.")
        return self


class _UpdateGroupInput(BaseModel):
    group_id: str = Field()
    kind: str | None = None
    reason: str | None = None
    item_ids: list[str] | None = Field(default=None)

    @model_validator(mode="after")
    def validate_update(self) -> _UpdateGroupInput:
        if not _normalized_id(self.group_id):
            raise ValueError("update_group requires group_id.")
        if self.item_ids is not None and not _dedupe_ids(self.item_ids):
            raise ValueError("item_ids must contain at least one non-empty item id.")
        return self


class _DeleteGroupInput(BaseModel):
    group_id: str = Field()

    @model_validator(mode="after")
    def validate_delete(self) -> _DeleteGroupInput:
        if not _normalized_id(self.group_id):
            raise ValueError("delete_group requires group_id.")
        return self


class _CreateGroupsInput(BaseModel):
    groups: list[_CreateGroupInput] = Field(default_factory=list)

    model_config = {"extra": "forbid"}


class _UpdateGroupsInput(BaseModel):
    groups: list[_UpdateGroupInput] = Field(default_factory=list)


class _DeleteGroupsInput(BaseModel):
    group_ids: list[str] = Field()

    @model_validator(mode="after")
    def validate_delete_groups(self) -> _DeleteGroupsInput:
        if not _dedupe_ids(self.group_ids):
            raise ValueError("delete_groups requires at least one non-empty group id.")
        return self


@dataclass
class _PlanningItem:
    item_id: str
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class _PlanningGroup:
    group_id: str
    kind: str
    item_ids: list[str] = field(default_factory=list)
    reason: str | None = None


@dataclass
class DeliveryWorkbenchState:
    ordered_item_ids: list[str]
    items_by_id: dict[str, _PlanningItem] = field(default_factory=dict)
    groups: dict[str, _PlanningGroup] = field(default_factory=dict)
    edit_events: list[dict[str, Any]] = field(default_factory=list)
    _next_group_number: int = 1

    @classmethod
    def initial(cls, ordered_item_ids: list[str]) -> DeliveryWorkbenchState:
        return cls.from_items(
            [{"item_id": item_id, "payload": {}} for item_id in ordered_item_ids]
        )

    @classmethod
    def from_items(cls, items: list[dict[str, Any]]) -> DeliveryWorkbenchState:
        ordered_item_ids: list[str] = []
        items_by_id: dict[str, _PlanningItem] = {}
        for item in items:
            if not isinstance(item, dict):
                continue
            item_id = _normalized_id(item.get("item_id"))
            if item_id is None or item_id in items_by_id:
                continue
            payload = item.get("payload")
            items_by_id[item_id] = _PlanningItem(
                item_id=item_id,
                payload=dict(payload) if isinstance(payload, dict) else {},
            )
            ordered_item_ids.append(item_id)
        return cls(ordered_item_ids=ordered_item_ids, items_by_id=items_by_id)

    def check_constraints(self) -> dict[str, Any]:
        return self.constraints()

    def read_groups(self) -> dict[str, Any]:
        return {"groups": self._groups_view()}

    def create_group(
        self,
        *,
        kind: str | None = None,
        reason: str | None = None,
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        payload = _CreateGroupInput(
            kind=kind or "delivery",
            reason=reason,
            item_ids=item_ids,
        )
        created_group_id = self._create_group(payload)
        self._record_edit("create_group")
        return self._mutation_result(
            operation="create_group",
            created_group_ids=[created_group_id],
            changed_group_ids=[created_group_id],
        )

    def create_groups(self, *, groups: list[dict[str, Any]]) -> dict[str, Any]:
        payload = _CreateGroupsInput(
            groups=[_CreateGroupInput.model_validate(group) for group in groups]
        )
        preflight_group_ids = self._next_create_group_ids(len(payload.groups))
        for group in payload.groups:
            self._validate_known_item_ids(group.item_ids)
        created_group_ids: list[str] = []
        for group, group_id in zip(payload.groups, preflight_group_ids, strict=True):
            created_group_ids.append(
                self._create_group(
                    _CreateGroupInput(
                        kind=group.kind,
                        reason=group.reason,
                        item_ids=group.item_ids,
                    ),
                    group_id=group_id,
                )
            )
        self._record_edit("create_groups")
        return self._mutation_result(
            operation="create_groups",
            created_group_ids=created_group_ids,
            changed_group_ids=created_group_ids,
        )

    def update_group(
        self,
        *,
        group_id: str,
        kind: str | None = None,
        reason: str | None = None,
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        payload = _UpdateGroupInput(
            group_id=group_id,
            kind=kind,
            reason=reason,
            item_ids=item_ids,
        )
        changed_group_id = self._update_group(payload)
        self._record_edit("update_group")
        return self._mutation_result(
            operation="update_group",
            changed_group_ids=[changed_group_id] if changed_group_id else [],
        )

    def update_groups(self, *, groups: list[dict[str, Any]]) -> dict[str, Any]:
        payload = _UpdateGroupsInput(
            groups=[_UpdateGroupInput.model_validate(group) for group in groups]
        )
        changed_group_ids: list[str] = []
        for group in payload.groups:
            changed_group_id = self._update_group(group)
            if changed_group_id:
                changed_group_ids.append(changed_group_id)
        self._record_edit("update_groups")
        return self._mutation_result(
            operation="update_groups",
            changed_group_ids=changed_group_ids,
        )

    def delete_group(self, *, group_id: str) -> dict[str, Any]:
        payload = _DeleteGroupInput(group_id=group_id)
        deleted_group_id, unprocessed_item_ids = self._delete_group(payload)
        self._record_edit("delete_group")
        return self._mutation_result(
            operation="delete_group",
            deleted_group_ids=[deleted_group_id] if deleted_group_id else [],
            changed_item_ids=unprocessed_item_ids,
            unprocessed_item_ids=unprocessed_item_ids,
        )

    def delete_groups(self, *, group_ids: list[str]) -> dict[str, Any]:
        payload = _DeleteGroupsInput(group_ids=group_ids)
        deleted_group_ids: list[str] = []
        unprocessed_item_ids: list[str] = []
        for group_id in _dedupe_ids(payload.group_ids):
            deleted_group_id, released_item_ids = self._delete_group(
                _DeleteGroupInput(group_id=group_id)
            )
            if deleted_group_id:
                deleted_group_ids.append(deleted_group_id)
            unprocessed_item_ids.extend(released_item_ids)
        self._record_edit("delete_groups")
        return self._mutation_result(
            operation="delete_groups",
            deleted_group_ids=deleted_group_ids,
            changed_item_ids=unprocessed_item_ids,
            unprocessed_item_ids=unprocessed_item_ids,
        )

    def finish(self) -> dict[str, Any]:
        constraints = self.constraints()
        if not constraints["ok"]:
            return {
                "ok": False,
                "constraints": constraints,
            }
        return {
            "ok": True,
            "deliveries": self.export_deliveries(),
            "constraints": constraints,
        }

    def constraints(self) -> dict[str, Any]:
        unprocessed_item_ids = self._unprocessed_item_ids()
        errors: list[dict[str, Any]] = []
        if unprocessed_item_ids:
            errors.append(
                {
                    "code": "incomplete_coverage",
                    "item_ids": unprocessed_item_ids,
                }
            )
        for group in self.groups.values():
            if group.kind != "delivery":
                errors.append(
                    {
                        "code": "invalid_group_kind",
                        "group_id": group.group_id,
                        "kind": group.kind,
                        "allowed_kinds": ["delivery"],
                    }
                )
        return {
            "ok": not errors,
            "errors": errors,
        }

    def export_deliveries(self) -> list[DeliveryEntry]:
        groups = [
            group
            for group in self.groups.values()
            if group.kind == "delivery" and group.item_ids
        ]
        ordered_groups = sorted(
            groups,
            key=lambda group: self.ordered_item_ids.index(group.item_ids[0]),
        )
        return [
            {
                "delivery_id": _system_delivery_id(
                    strategy=_strategy_for_item_ids(group.item_ids),
                    case_ids=group.item_ids,
                ),
                "strategy": _strategy_for_item_ids(group.item_ids),
                "case_ids": list(group.item_ids),
                "reason": group.reason or "Independent delivery.",
            }
            for group in ordered_groups
        ]

    def group_drafts(self) -> list[dict[str, Any]]:
        groups = [
            group
            for group in self.groups.values()
            if group.kind == "delivery" and group.item_ids
        ]
        ordered_groups = sorted(
            groups,
            key=lambda group: self.ordered_item_ids.index(group.item_ids[0]),
        )
        return [
            {
                "kind": group.kind,
                "reason": group.reason,
                "item_ids": list(group.item_ids),
            }
            for group in ordered_groups
        ]

    def _create_group(
        self,
        command: _CreateGroupInput,
        *,
        group_id: str | None = None,
    ) -> str:
        group_id = _normalized_id(group_id) or self._next_group_id()
        if group_id in self.groups:
            raise ValueError(f"group already exists: {group_id}")
        self._validate_known_item_ids(command.item_ids)

        group = _PlanningGroup(
            group_id=group_id,
            kind=_normalized_group_kind(command.kind),
            reason=_normalized_text(command.reason),
        )
        self.groups[group_id] = group
        if command.item_ids is not None:
            self._replace_group_item_ids(
                group_id,
                command.item_ids,
            )
        return group_id

    def _next_create_group_ids(self, count: int) -> list[str]:
        existing_group_ids = set(self.groups)
        preflight_group_ids: list[str] = []
        next_group_number = self._next_group_number
        for _ in range(count):
            while True:
                group_id = f"group-{next_group_number}"
                next_group_number += 1
                if (
                    group_id not in existing_group_ids
                    and group_id not in preflight_group_ids
                ):
                    break
            preflight_group_ids.append(group_id)
        return preflight_group_ids

    def _update_group(
        self,
        command: _UpdateGroupInput,
    ) -> str:
        group_id = _normalized_id(command.group_id)
        group = self.groups.get(str(group_id))
        if group is None:
            raise ValueError(f"unknown group_id: {command.group_id}")
        self._validate_known_item_ids(command.item_ids)

        if command.kind is not None:
            group.kind = _normalized_group_kind(command.kind)
        if command.reason is not None:
            group.reason = _normalized_text(command.reason)
        if command.item_ids is not None:
            self._replace_group_item_ids(
                group.group_id,
                command.item_ids,
            )
        return group.group_id

    def _delete_group(
        self,
        command: _DeleteGroupInput,
    ) -> tuple[str | None, list[str]]:
        group_id = _normalized_id(command.group_id)
        if str(group_id) not in self.groups:
            return None, []
        group = self.groups.pop(str(group_id))
        return group.group_id, list(group.item_ids)

    def _replace_group_item_ids(
        self,
        group_id: str,
        item_ids: list[str],
    ) -> None:
        known_item_ids = self._known_item_ids(item_ids)
        for other_group in self.groups.values():
            if other_group.group_id == group_id:
                continue
            other_group.item_ids = [
                item_id
                for item_id in other_group.item_ids
                if item_id not in set(known_item_ids)
            ]
        self.groups[group_id].item_ids = known_item_ids

    def _known_item_ids(self, item_ids: list[str]) -> list[str]:
        normalized = _dedupe_ids(item_ids)
        self._validate_known_item_ids(normalized)
        return [item_id for item_id in self.ordered_item_ids if item_id in normalized]

    def _validate_known_item_ids(self, item_ids: list[str] | None) -> None:
        unknown_item_ids = [
            item_id
            for item_id in _dedupe_ids(item_ids)
            if item_id not in self.items_by_id
        ]
        if unknown_item_ids:
            raise ValueError(f"unknown item_id(s): {', '.join(unknown_item_ids)}")

    def _next_group_id(self) -> str:
        while True:
            group_id = f"group-{self._next_group_number}"
            self._next_group_number += 1
            if group_id not in self.groups:
                return group_id

    def _record_edit(self, operation: str) -> None:
        self.edit_events.append(
            {
                "operation": operation,
            }
        )

    def _unprocessed_item_ids(self) -> list[str]:
        assigned_item_ids = {
            item_id for group in self.groups.values() for item_id in group.item_ids
        }
        return [
            item_id
            for item_id in self.ordered_item_ids
            if item_id not in assigned_item_ids
        ]

    def _groups_view(self) -> list[dict[str, Any]]:
        return [
            self._group_summary(group)
            for group in sorted(
                self.groups.values(),
                key=lambda item: item.group_id,
            )
        ]

    def _group_summary(self, group: _PlanningGroup) -> dict[str, Any]:
        return {
            "group_id": group.group_id,
            "kind": group.kind,
            "reason": group.reason,
            "item_ids": list(group.item_ids),
        }

    def _mutation_result(
        self,
        *,
        operation: str,
        created_group_ids: list[str] | None = None,
        changed_group_ids: list[str] | None = None,
        deleted_group_ids: list[str] | None = None,
        changed_item_ids: list[str] | None = None,
        unprocessed_item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        changed_group_ids = _dedupe_ids(changed_group_ids or [])
        changed_groups = [
            self._compact_group_view(self.groups[group_id])
            for group_id in changed_group_ids
            if group_id in self.groups
        ]
        derived_changed_item_ids = [
            item_id for group in changed_groups for item_id in group["item_ids"]
        ]
        constraints = self.constraints()
        result: dict[str, Any] = {
            "ok": True,
            "operation": operation,
            "created_group_ids": _dedupe_ids(created_group_ids or []),
            "changed_group_ids": changed_group_ids,
            "deleted_group_ids": _dedupe_ids(deleted_group_ids or []),
            "changed_item_ids": _dedupe_ids(
                (changed_item_ids or []) + derived_changed_item_ids
            ),
            "changed_groups": changed_groups,
            "constraints": {
                "ok": constraints["ok"],
                "error_count": len(constraints["errors"]),
            },
        }
        if unprocessed_item_ids is not None:
            result["unprocessed_item_ids"] = _dedupe_ids(unprocessed_item_ids)
        return result

    def _compact_group_view(self, group: _PlanningGroup) -> dict[str, Any]:
        return {
            "group_id": group.group_id,
            "kind": group.kind,
            "item_ids": list(group.item_ids),
        }


def _dedupe_ids(ids: list[str] | None) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for raw_id in ids or []:
        item_id = str(raw_id or "").strip()
        if not item_id or item_id in seen:
            continue
        seen.add(item_id)
        result.append(item_id)
    return result


def _normalized_id(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalized_group_kind(value: Any) -> str:
    kind = str(value or "delivery").strip().lower()
    return kind or "delivery"


def _normalized_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _system_delivery_id(*, strategy: str, case_ids: list[str]) -> str:
    normalized_case_ids = sorted(
        {
            str(case_id or "").strip()
            for case_id in case_ids
            if str(case_id or "").strip()
        }
    )
    if strategy == "single" and len(normalized_case_ids) == 1:
        return normalized_case_ids[0]
    fingerprint = "|".join(normalized_case_ids)
    return f"combined-{hashlib.sha1(fingerprint.encode('utf-8')).hexdigest()[:10]}"


def _strategy_for_item_ids(item_ids: list[str]) -> DeliveryStrategy:
    return "combined" if len(item_ids) >= 2 else "single"


__all__ = [
    "DeliveryWorkbenchState",
]
