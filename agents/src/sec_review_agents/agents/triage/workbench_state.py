import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field, model_validator

from sec_review_agents.scan_stages.triage.result import (
    SuppressedCandidate,
    TriageCase,
)


class _CreateGroupInput(BaseModel):
    kind: str | None = None
    reason: str | None = None
    summary: str | None = None
    category: str | None = None
    evidence: list[str] | None = None
    item_ids: list[str] | None = Field(default=None)

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def validate_create(self) -> _CreateGroupInput:
        if not _dedupe_ids(self.item_ids):
            raise ValueError("create_group requires non-empty item_ids.")
        kind = _normalized_group_kind(self.kind)
        if kind == "keep":
            if (
                not _normalized_text(self.summary)
                or not _normalized_text(self.category)
                or not _non_empty_strings(self.evidence)
            ):
                raise ValueError(
                    "create_group keep groups require summary, category, "
                    "and non-empty evidence."
                )
        elif kind == "suppress" and not _normalized_text(self.reason):
            raise ValueError("create_group suppress groups require reason.")
        return self


class _UpdateGroupInput(BaseModel):
    group_id: str = Field()
    kind: str | None = None
    reason: str | None = None
    summary: str | None = None
    category: str | None = None
    evidence: list[str] | None = None
    item_ids: list[str] | None = Field(default=None)

    @model_validator(mode="after")
    def validate_update(self) -> _UpdateGroupInput:
        if not _normalized_id(self.group_id):
            raise ValueError("update_group requires group_id.")
        if self.kind is not None:
            _normalized_group_kind(self.kind)
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
class _TriageItem:
    item_id: str
    # Keep the original discovery candidate for system export; expose only payload
    # to the agent as the workbench item's evidence.
    candidate: dict[str, Any] = field(default_factory=dict)
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class _TriageGroup:
    group_id: str
    kind: str
    item_ids: list[str] = field(default_factory=list)
    reason: str | None = None
    summary: str | None = None
    category: str | None = None
    evidence: list[str] | None = None


@dataclass
class TriageWorkbenchState:
    ordered_item_ids: list[str]
    items_by_id: dict[str, _TriageItem] = field(default_factory=dict)
    groups: dict[str, _TriageGroup] = field(default_factory=dict)
    edit_events: list[dict[str, Any]] = field(default_factory=list)
    _next_group_number: int = 1

    @classmethod
    def from_candidates(cls, candidates: list[dict[str, Any]]) -> TriageWorkbenchState:
        ordered_item_ids: list[str] = []
        items_by_id: dict[str, _TriageItem] = {}
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            item_id = _normalized_id(candidate.get("candidate_id"))
            if item_id is None or item_id in items_by_id:
                continue
            items_by_id[item_id] = _TriageItem(
                item_id=item_id,
                candidate=dict(candidate),
                payload=_candidate_payload(candidate),
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
        summary: str | None = None,
        category: str | None = None,
        evidence: list[str] | None = None,
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        payload = _CreateGroupInput(
            kind=kind,
            reason=reason,
            summary=summary,
            category=category,
            evidence=evidence,
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
                        summary=group.summary,
                        category=group.category,
                        evidence=group.evidence,
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
        summary: str | None = None,
        category: str | None = None,
        evidence: list[str] | None = None,
        item_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        payload = _UpdateGroupInput(
            group_id=group_id,
            kind=kind,
            reason=reason,
            summary=summary,
            category=category,
            evidence=evidence,
            item_ids=item_ids,
        )
        changed_group_id = self._update_group(payload)
        self._record_edit("update_group")
        return self._mutation_result(
            operation="update_group",
            changed_group_ids=[changed_group_id],
        )

    def update_groups(self, *, groups: list[dict[str, Any]]) -> dict[str, Any]:
        payload = _UpdateGroupsInput(
            groups=[_UpdateGroupInput.model_validate(group) for group in groups]
        )
        changed_group_ids: list[str] = []
        for group in payload.groups:
            changed_group_ids.append(self._update_group(group))
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
            return {"ok": False, "constraints": constraints}
        cases, suppressed_candidates = self.export_cases_and_suppressions()
        return {
            "ok": True,
            "cases": cases,
            "suppressed_candidates": suppressed_candidates,
            "constraints": constraints,
        }

    def constraints(self) -> dict[str, Any]:
        errors: list[dict[str, Any]] = []
        unprocessed_item_ids = self._unprocessed_item_ids()
        if unprocessed_item_ids:
            errors.append(
                {"code": "incomplete_coverage", "item_ids": unprocessed_item_ids}
            )
        for group in self.groups.values():
            if not group.item_ids:
                errors.append({"code": "empty_group", "group_id": group.group_id})
                continue
            if group.kind == "keep":
                if not _normalized_text(group.summary):
                    errors.append(
                        {"code": "keep_missing_summary", "group_id": group.group_id}
                    )
                if not _normalized_text(group.category):
                    errors.append(
                        {"code": "keep_missing_category", "group_id": group.group_id}
                    )
                if not _non_empty_strings(group.evidence):
                    errors.append(
                        {"code": "keep_missing_evidence", "group_id": group.group_id}
                    )
            elif group.kind == "suppress":
                if not _normalized_text(group.reason):
                    errors.append(
                        {"code": "suppress_missing_reason", "group_id": group.group_id}
                    )
            else:
                errors.append(
                    {
                        "code": "invalid_group_kind",
                        "group_id": group.group_id,
                        "kind": group.kind,
                    }
                )
        return {"ok": not errors, "errors": errors}

    def export_cases_and_suppressions(
        self,
    ) -> tuple[list[TriageCase], list[SuppressedCandidate]]:
        cases: list[TriageCase] = []
        suppressed_candidates: list[SuppressedCandidate] = []
        ordered_groups = sorted(
            self.groups.values(),
            key=lambda group: (
                self.ordered_item_ids.index(group.item_ids[0])
                if group.item_ids and group.item_ids[0] in self.ordered_item_ids
                else len(self.ordered_item_ids)
            ),
        )
        for group in ordered_groups:
            member_candidates = [
                self.items_by_id[item_id].candidate
                for item_id in group.item_ids
                if item_id in self.items_by_id
            ]
            if not member_candidates:
                continue
            if group.kind == "keep":
                cases.append(
                    build_case_from_candidates(
                        category=_normalized_text(group.category)
                        or str(member_candidates[0].get("category") or "").strip(),
                        summary=_normalized_text(group.summary)
                        or str(member_candidates[0].get("description") or "").strip(),
                        evidence=_non_empty_strings(group.evidence)
                        or _candidate_case_evidence(member_candidates[0]),
                        member_candidates=member_candidates,
                    )
                )
            elif group.kind == "suppress":
                reason = _normalized_text(group.reason) or "suppressed"
                for candidate in member_candidates:
                    suppressed_candidates.append(
                        {
                            "candidate_id": candidate["candidate_id"],
                            "reason": reason,
                            "category": candidate.get("category"),
                        }
                    )
        cases.sort(key=lambda item: item["case_id"])
        return cases, suppressed_candidates

    def group_drafts(self) -> list[dict[str, Any]]:
        return [
            {
                "kind": group.kind,
                "reason": group.reason,
                "summary": group.summary,
                "category": group.category,
                "evidence": group.evidence,
                "item_ids": list(group.item_ids),
            }
            for group in self.groups.values()
            if group.item_ids
        ]

    def prompt_items(self) -> list[dict[str, Any]]:
        return [
            {"item_id": item_id, "payload": self.items_by_id[item_id].payload}
            for item_id in self.ordered_item_ids
            if item_id in self.items_by_id
        ]

    def _create_group(
        self,
        payload: _CreateGroupInput,
        *,
        group_id: str | None = None,
    ) -> str:
        group_id = _normalized_id(group_id) or self._next_group_id()
        if group_id in self.groups:
            raise ValueError(f"group already exists: {group_id}")
        self._validate_known_item_ids(payload.item_ids)
        group = _TriageGroup(
            group_id=group_id,
            kind=_normalized_group_kind(payload.kind),
            reason=_normalized_text(payload.reason),
            summary=_normalized_text(payload.summary),
            category=_normalized_text(payload.category),
            evidence=_non_empty_strings(payload.evidence),
        )
        self.groups[group_id] = group
        if payload.item_ids is not None:
            self._replace_group_items(group_id, payload.item_ids)
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

    def _update_group(self, payload: _UpdateGroupInput) -> str:
        group_id = _normalized_id(payload.group_id)
        if group_id is None or group_id not in self.groups:
            raise ValueError(f"unknown group_id: {payload.group_id}")
        self._validate_known_item_ids(payload.item_ids)
        group = self.groups[group_id]
        if payload.kind is not None:
            group.kind = _normalized_group_kind(payload.kind)
        if payload.reason is not None:
            group.reason = _normalized_text(payload.reason)
        if payload.summary is not None:
            group.summary = _normalized_text(payload.summary)
        if payload.category is not None:
            group.category = _normalized_text(payload.category)
        if payload.evidence is not None:
            group.evidence = _non_empty_strings(payload.evidence)
        if payload.item_ids is not None:
            self._replace_group_items(group_id, payload.item_ids)
        return group_id

    def _delete_group(self, payload: _DeleteGroupInput) -> tuple[str | None, list[str]]:
        group_id = _normalized_id(payload.group_id)
        if group_id is None:
            return None, []
        group = self.groups.pop(group_id, None)
        if group is None:
            return None, []
        return group_id, list(group.item_ids)

    def _replace_group_items(self, group_id: str, item_ids: list[str]) -> None:
        group = self.groups[group_id]
        normalized_item_ids = _dedupe_ids(item_ids)
        self._validate_known_item_ids(normalized_item_ids)
        for other_group in self.groups.values():
            if other_group.group_id == group_id:
                continue
            other_group.item_ids = [
                item_id
                for item_id in other_group.item_ids
                if item_id not in normalized_item_ids
            ]
        group.item_ids = normalized_item_ids

    def _validate_known_item_ids(self, item_ids: list[str] | None) -> None:
        unknown_item_ids = [
            item_id
            for item_id in _dedupe_ids(item_ids)
            if item_id not in self.items_by_id
        ]
        if unknown_item_ids:
            raise ValueError(f"unknown item_id(s): {', '.join(unknown_item_ids)}")

    def _groups_view(self) -> list[dict[str, Any]]:
        return [
            {
                "group_id": group.group_id,
                "kind": group.kind,
                "reason": group.reason,
                "summary": group.summary,
                "category": group.category,
                "evidence": list(group.evidence or []),
                "item_ids": list(group.item_ids),
            }
            for group in sorted(
                self.groups.values(),
                key=lambda item: _group_sort_key(item, self.ordered_item_ids),
            )
        ]

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

    def _compact_group_view(self, group: _TriageGroup) -> dict[str, Any]:
        return {
            "group_id": group.group_id,
            "kind": group.kind,
            "item_ids": list(group.item_ids),
        }

    def _unprocessed_item_ids(self) -> list[str]:
        processed = {
            item_id for group in self.groups.values() for item_id in group.item_ids
        }
        return [
            item_id for item_id in self.ordered_item_ids if item_id not in processed
        ]

    def _next_group_id(self) -> str:
        while True:
            group_id = f"group-{self._next_group_number}"
            self._next_group_number += 1
            if group_id not in self.groups:
                return group_id

    def _record_edit(self, operation: str) -> None:
        self.edit_events.append({"operation": operation})


def _candidate_payload(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "category": candidate.get("category"),
        "locations": candidate.get("locations") or [],
        "description": candidate.get("description"),
        "evidence": candidate.get("evidence") or [],
        "grounding_status": candidate.get("grounding_status"),
    }


def build_case_from_candidates(
    *,
    category: str,
    summary: str,
    evidence: list[str],
    member_candidates: list[dict[str, Any]],
) -> TriageCase:
    case_id = _stable_case_id(member_candidates)
    locations = [
        location
        for candidate in member_candidates
        for location in candidate.get("locations") or []
    ]
    return {
        "case_id": case_id,
        "category": category,
        "summary": summary,
        "evidence": _non_empty_strings(evidence),
        "member_candidate_ids": [
            candidate["candidate_id"] for candidate in member_candidates
        ],
        "anchor_locations": locations,
    }


def _stable_case_id(member_candidates: list[dict[str, Any]]) -> str:
    candidate_components = sorted(
        _candidate_case_component(candidate) for candidate in member_candidates
    )
    payload = "||".join(candidate_components)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:14]


def _candidate_case_component(candidate: dict[str, Any]) -> str:
    payload = {
        "candidate_id": candidate.get("candidate_id"),
        "category": candidate.get("category"),
        "locations": sorted(
            f"{item.get('file') or ''!s}:{int(item.get('line') or 0)}"
            for item in (candidate.get("locations") or [])
            if int(item.get("line") or 0) > 0
        ),
        "evidence": [
            _normalized_key_fragment(item)[:120]
            for item in (candidate.get("evidence") or [])
            if _normalized_key_fragment(item)
        ],
    }
    return hashlib.sha1(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).hexdigest()[:24]


def _candidate_case_evidence(candidate: dict[str, Any]) -> list[str]:
    evidence = _non_empty_strings(candidate.get("evidence") or [])
    if evidence:
        return evidence
    labels = _non_empty_strings(
        [item.get("label") for item in (candidate.get("locations") or [])]
    )
    summary = str(candidate.get("description") or "").strip()
    return labels or ([summary] if summary else [])


def _normalized_key_fragment(value: Any) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")


def _group_sort_key(
    group: _TriageGroup, ordered_item_ids: list[str]
) -> tuple[int, str]:
    if not group.item_ids:
        return (len(ordered_item_ids), group.group_id)
    first_item_id = group.item_ids[0]
    if first_item_id not in ordered_item_ids:
        return (len(ordered_item_ids), group.group_id)
    return (ordered_item_ids.index(first_item_id), group.group_id)


def _normalized_id(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _normalized_group_kind(value: Any) -> str:
    kind = str(value or "keep").strip().lower()
    if kind in {"keep", "suppress"}:
        return kind
    raise ValueError(f"invalid triage group kind: {kind or value}")


def _normalized_text(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _dedupe_ids(values: list[str] | None) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        normalized = _normalized_id(value)
        if normalized is None or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
    return deduped


def _non_empty_strings(values: Any) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        values = [values]
    return [str(value or "").strip() for value in values if str(value or "").strip()]


__all__ = ["TriageWorkbenchState", "build_case_from_candidates"]
