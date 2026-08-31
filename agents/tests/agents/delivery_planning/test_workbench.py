from typing import Any, Protocol, TypeGuard

import pytest
from pydantic import ValidationError

from sec_review_agents.agents.delivery_planning.agent import (
    _delivery_planning_done_model,
)
from sec_review_agents.agents.delivery_planning.workbench_state import (
    DeliveryWorkbenchState,
)
from sec_review_agents.agents.delivery_planning.workbench_tools import (
    build_delivery_workbench_tools,
)


class _ModelJsonSchemaClass(Protocol):
    @classmethod
    def model_json_schema(cls) -> dict[str, Any]: ...


def _has_model_json_schema(value: type) -> TypeGuard[type[_ModelJsonSchemaClass]]:
    return hasattr(value, "model_json_schema")


def test_delivery_planning_workbench_state_constraints_reports_incomplete_coverage() -> (
    None
):
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    workbench_state.create_group(item_ids=["case-a"])
    assert workbench_state.constraints()["ok"] is False
    assert workbench_state.constraints()["errors"] == [
        {"code": "incomplete_coverage", "item_ids": ["case-b"]}
    ]


def test_delivery_planning_workbench_state_moves_items_between_groups() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    workbench_state.create_group(item_ids=["case-a", "case-b"])
    workbench_state.create_group(item_ids=["case-b"])
    assert workbench_state.constraints()["ok"] is True
    assert workbench_state.constraints()["errors"] == []
    assert [
        (item["strategy"], item["case_ids"])
        for item in workbench_state.export_deliveries()
    ] == [
        ("single", ["case-a"]),
        ("single", ["case-b"]),
    ]


def test_delivery_planning_workbench_state_duplicate_assignment_is_auto_moved() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    first = workbench_state.create_group(item_ids=["case-a", "case-b"])[
        "created_group_ids"
    ][0]
    second = workbench_state.create_group(item_ids=["case-b"])["created_group_ids"][0]

    groups = {
        group["group_id"]: group["item_ids"]
        for group in workbench_state.read_groups()["groups"]
    }
    assert groups[first] == ["case-a"]
    assert groups[second] == ["case-b"]
    assert sum(item_ids.count("case-b") for item_ids in groups.values()) == 1
    assert workbench_state.check_constraints() == {"ok": True, "errors": []}


def test_delivery_planning_workbench_state_rejects_empty_item_ids_on_update() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a"])
    group_id = workbench_state.create_group(item_ids=["case-a"])["created_group_ids"][0]
    with pytest.raises(ValueError) as context:
        workbench_state.update_group(group_id=group_id, item_ids=[])
    assert "item_ids must contain at least one" in str(context.value)


def test_delivery_planning_workbench_state_updates_reason_without_item_ids() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a"])
    group_id = workbench_state.create_group(item_ids=["case-a"])["created_group_ids"][0]

    result = workbench_state.update_group(
        group_id=group_id,
        reason="shared patch boundary",
    )

    assert result["operation"] == "update_group"
    groups = workbench_state.read_groups()["groups"]
    assert groups[0]["item_ids"] == ["case-a"]
    assert groups[0]["reason"] == "shared patch boundary"


def test_delivery_planning_workbench_state_groups_cases_without_losing_coverage() -> (
    None
):
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b", "case-c"])
    workbench_state.create_group(item_ids=["case-a", "case-b"], reason="shared files")
    workbench_state.create_group(item_ids=["case-c"])

    assert workbench_state.constraints()["ok"] is True
    deliveries = workbench_state.export_deliveries()
    assert [(item["strategy"], item["case_ids"]) for item in deliveries] == [
        ("combined", ["case-a", "case-b"]),
        ("single", ["case-c"]),
    ]


def test_delivery_planning_workbench_state_rejects_unknown_item_ids() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])

    with pytest.raises(ValueError) as context:
        workbench_state.create_group(item_ids=["case-a", "missing"])

    assert "unknown item_id(s): missing" in str(context.value)
    assert workbench_state.read_groups()["groups"] == []


def test_delivery_planning_workbench_state_rejects_create_time_group_ids() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a"])

    with pytest.raises(ValueError) as context:
        workbench_state.create_groups(
            groups=[
                {
                    "group_id": "agent-picked-group",
                    "item_ids": ["case-a"],
                }
            ]
        )

    assert "Extra inputs are not permitted" in str(context.value)
    assert workbench_state.read_groups()["groups"] == []


def test_delivery_planning_workbench_state_rejects_unknown_group_kind() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a"])
    workbench_state.create_group(
        kind="not-delivery",
        item_ids=["case-a"],
    )

    assert workbench_state.constraints()["errors"] == [
        {
            "code": "invalid_group_kind",
            "group_id": "group-1",
            "kind": "not-delivery",
            "allowed_kinds": ["delivery"],
        }
    ]
    assert workbench_state.finish()["ok"] is False
    assert workbench_state.export_deliveries() == []


def test_delivery_planning_workbench_state_rejects_unknown_group_update() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])

    with pytest.raises(ValueError) as context:
        workbench_state.update_group(group_id="missing-group")

    assert "unknown group_id" in str(context.value)


def test_delivery_planning_workbench_state_updates_group_membership() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    combined = workbench_state.create_group(item_ids=["case-a", "case-b"])[
        "created_group_ids"
    ][0]
    workbench_state.update_group(group_id=combined, item_ids=["case-a"])
    workbench_state.create_group(item_ids=["case-b"])

    assert workbench_state.constraints()["ok"] is True
    assert [
        (item["strategy"], item["case_ids"])
        for item in workbench_state.export_deliveries()
    ] == [
        ("single", ["case-a"]),
        ("single", ["case-b"]),
    ]


def test_delivery_planning_workbench_state_exposes_crud_api() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])

    group_id = workbench_state.create_group(
        item_ids=["case-a"],
        reason="First delivery.",
    )["created_group_ids"][0]
    workbench_state.update_group(
        group_id=group_id,
        item_ids=["case-a", "case-b"],
        reason="Shared files.",
    )

    assert workbench_state.check_constraints()["ok"] is True
    assert workbench_state.finish()["deliveries"][0]["case_ids"] == [
        "case-a",
        "case-b",
    ]

    workbench_state.delete_group(group_id=group_id)
    assert workbench_state.check_constraints()["errors"] == [
        {"code": "incomplete_coverage", "item_ids": ["case-a", "case-b"]}
    ]


def test_delivery_planning_workbench_state_mutations_return_compact_ack() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])

    result = workbench_state.create_group(
        item_ids=["case-a"],
        reason="First delivery.",
    )

    assert result["operation"] == "create_group"
    assert result["created_group_ids"] == ["group-1"]
    assert result["changed_groups"] == [
        {"group_id": "group-1", "kind": "delivery", "item_ids": ["case-a"]}
    ]
    assert result["constraints"] == {"ok": False, "error_count": 1}
    assert "groups" not in result
    assert "reason" not in result["changed_groups"][0]

    update_result = workbench_state.update_group(
        group_id=result["created_group_ids"][0],
        item_ids=["case-a", "case-b"],
        reason="Shared files.",
    )

    assert update_result["operation"] == "update_group"
    assert update_result["changed_group_ids"] == ["group-1"]
    assert update_result["changed_item_ids"] == ["case-a", "case-b"]
    assert update_result["constraints"] == {"ok": True, "error_count": 0}

    delete_result = workbench_state.delete_group(
        group_id=result["created_group_ids"][0]
    )

    assert delete_result["operation"] == "delete_group"
    assert delete_result["deleted_group_ids"] == ["group-1"]
    assert delete_result["unprocessed_item_ids"] == ["case-a", "case-b"]
    assert delete_result["changed_groups"] == []


def test_delivery_planning_workbench_state_exposes_explicit_checks() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    workbench_state.create_group(item_ids=["case-a"])

    assert workbench_state.check_constraints() == {
        "ok": False,
        "errors": [{"code": "incomplete_coverage", "item_ids": ["case-b"]}],
    }


def test_delivery_planning_workbench_state_keeps_prompt_payloads_internal() -> None:
    workbench_state = DeliveryWorkbenchState.from_items(
        [
            {
                "item_id": "case-a",
                "payload": {"changed_files": ["src/a.ts"]},
            },
            {"item_id": "case-b", "payload": {"custom": "value"}},
        ]
    )
    workbench_state.create_group(item_ids=["case-a"])

    assert workbench_state.read_groups()["groups"][0] == {
        "group_id": "group-1",
        "kind": "delivery",
        "reason": None,
        "item_ids": ["case-a"],
    }
    assert not hasattr(workbench_state, "read_group")


def test_delivery_planning_workbench_state_rejects_empty_create_item_ids() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])

    with pytest.raises(ValueError) as context:
        workbench_state.create_group()

    assert "requires non-empty item_ids" in str(context.value)
    assert workbench_state.read_groups()["groups"] == []


def test_delivery_planning_tool_schema_rejects_empty_create_item_ids() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    tools = {
        tool.name: tool for tool in build_delivery_workbench_tools(workbench_state)
    }

    with pytest.raises(ValueError) as context:
        tools["create_groups"].invoke(
            {
                "groups": [
                    {
                        "reason": "Missing membership.",
                    }
                ]
            }
        )

    assert "requires non-empty item_ids" in str(context.value)
    assert workbench_state.read_groups()["groups"] == []


def test_delivery_planning_tools_accept_llm_contract_field_names() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    tools = {
        tool.name: tool for tool in build_delivery_workbench_tools(workbench_state)
    }

    assert "read_view" not in tools
    assert "check_unprocessed" not in tools
    assert set(tools["check_constraints"].args) == set()
    assert set(tools["read_groups"].args) == set()
    assert "read_group" not in tools
    assert "read_item" not in tools
    assert "read_items" not in tools
    assert set(tools["create_group"].args) == {"kind", "reason", "item_ids"}
    assert set(tools["create_groups"].args) == {"groups"}
    assert set(tools["update_groups"].args) == {"groups"}
    assert set(tools["delete_groups"].args) == {"group_ids"}
    args_schema = tools["create_groups"].args_schema
    assert isinstance(args_schema, type)
    assert _has_model_json_schema(args_schema)
    schema = args_schema.model_json_schema()
    assert isinstance(schema, dict)
    defs = schema["$defs"]
    assert isinstance(defs, dict)
    create_group_spec = defs["CreateGroupSpec"]
    assert isinstance(create_group_spec, dict)
    properties = create_group_spec["properties"]
    assert isinstance(properties, dict)
    assert set(properties) == {
        "kind",
        "reason",
        "item_ids",
    }
    create_result = tools["create_group"].invoke(
        {
            "item_ids": ["case-a"],
            "reason": "First delivery.",
        }
    )
    group_id = create_result["created_group_ids"][0]
    tools["update_group"].invoke(
        {
            "group_id": group_id,
            "item_ids": ["case-a", "case-b"],
            "reason": "Combined delivery.",
        }
    )

    assert workbench_state.constraints()["ok"] is True
    assert workbench_state.finish()["deliveries"][0]["case_ids"] == [
        "case-a",
        "case-b",
    ]


def test_delivery_planning_create_groups_accepts_complete_draft() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b", "case-c"])

    workbench_state.create_groups(
        groups=[
            {
                "kind": "delivery",
                "item_ids": ["case-a", "case-b"],
                "reason": "Shared patch surface.",
            },
            {
                "kind": "delivery",
                "item_ids": ["case-c"],
                "reason": "Independent delivery.",
            },
        ]
    )

    assert workbench_state.constraints()["ok"] is True
    assert [
        (item["strategy"], item["case_ids"])
        for item in workbench_state.finish()["deliveries"]
    ] == [
        ("combined", ["case-a", "case-b"]),
        ("single", ["case-c"]),
    ]


def test_delivery_planning_group_drafts_snapshot_can_seed_global_state() -> None:
    batch_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    batch_state.create_groups(
        groups=[
            {
                "kind": "delivery",
                "item_ids": ["case-a", "case-b"],
                "reason": "Shared patch surface.",
            }
        ]
    )

    drafts = batch_state.group_drafts()

    assert drafts == [
        {
            "kind": "delivery",
            "reason": "Shared patch surface.",
            "item_ids": ["case-a", "case-b"],
        }
    ]
    assert "group_id" not in drafts[0]

    global_state = DeliveryWorkbenchState.initial(["case-a", "case-b", "case-c"])
    global_state.create_groups(groups=drafts)
    global_state.create_group(
        item_ids=["case-c"],
        reason="Independent delivery.",
    )

    assert global_state.constraints()["ok"] is True
    assert [
        (item["strategy"], item["case_ids"])
        for item in global_state.export_deliveries()
    ] == [
        ("combined", ["case-a", "case-b"]),
        ("single", ["case-c"]),
    ]


def test_delivery_planning_batch_tools_accept_llm_contract() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    tools = {
        tool.name: tool for tool in build_delivery_workbench_tools(workbench_state)
    }

    tools["create_groups"].invoke(
        {
            "groups": [
                {
                    "kind": "delivery",
                    "item_ids": ["case-a", "case-b"],
                    "reason": "Combined delivery.",
                }
            ]
        }
    )

    assert workbench_state.constraints()["ok"] is True
    assert workbench_state.finish()["deliveries"][0]["case_ids"] == [
        "case-a",
        "case-b",
    ]
    group_id = workbench_state.read_groups()["groups"][0]["group_id"]
    tools["update_groups"].invoke(
        {
            "groups": [
                {
                    "group_id": group_id,
                    "item_ids": ["case-a"],
                    "reason": "First delivery.",
                }
            ]
        }
    )
    assert workbench_state.export_deliveries()[0]["case_ids"] == ["case-a"]
    tools["delete_groups"].invoke({"group_ids": [group_id]})
    assert workbench_state.check_constraints()["errors"] == [
        {"code": "incomplete_coverage", "item_ids": ["case-a", "case-b"]}
    ]


def test_delivery_planning_done_response_requires_complete_workbench_state() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a", "case-b"])
    done_model = _delivery_planning_done_model(workbench_state)

    with pytest.raises(ValidationError):
        done_model(done=True)

    workbench_state.create_groups(
        groups=[
            {
                "kind": "delivery",
                "item_ids": ["case-a", "case-b"],
                "reason": "Combined delivery.",
            }
        ]
    )

    done_response = done_model(done=True)
    assert done_response.model_dump()["done"] is True


def test_delivery_workbench_defaults_missing_reason_to_entry_string() -> None:
    workbench_state = DeliveryWorkbenchState.initial(["case-a"])
    workbench_state.create_group(item_ids=["case-a"])
    deliveries = workbench_state.export_deliveries()

    assert deliveries[0]["reason"] == "Independent delivery."
