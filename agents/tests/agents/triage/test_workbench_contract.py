import pytest

from sec_review_agents.agents.triage.workbench_state import (
    TriageWorkbenchState,
    build_case_from_candidates,
)
from sec_review_agents.agents.triage.workbench_tools import (
    build_triage_workbench_tools,
)


def test_case_id_includes_candidate_id() -> None:
    base_candidate = {
        "category": "xss",
        "locations": [{"file": "app/views.py", "line": 10, "label": "sink"}],
        "evidence": ["render_template_string(user_input)"],
    }
    first = build_case_from_candidates(
        category="xss",
        summary="First",
        evidence=["render_template_string(user_input)"],
        member_candidates=[{**base_candidate, "candidate_id": "cand-a"}],
    )
    second = build_case_from_candidates(
        category="xss",
        summary="Second",
        evidence=["render_template_string(user_input)"],
        member_candidates=[{**base_candidate, "candidate_id": "cand-b"}],
    )

    assert first["case_id"] != second["case_id"]


def test_case_build_preserves_all_member_candidate_locations() -> None:
    candidates = [
        {
            "candidate_id": f"cand-{index}",
            "category": "xss",
            "locations": [
                {
                    "file": f"app/file_{index}.py",
                    "line": index,
                    "label": f"sink {index}",
                }
            ],
            "evidence": [f"evidence {index}"],
        }
        for index in range(1, 6)
    ]

    case = build_case_from_candidates(
        category="xss",
        summary="Merged case",
        evidence=["same root issue"],
        member_candidates=candidates,
    )

    assert [item["label"] for item in case["anchor_locations"]] == [
        "sink 1",
        "sink 2",
        "sink 3",
        "sink 4",
        "sink 5",
    ]


def test_triage_workbench_state_exports_cases_and_suppressions() -> None:
    state = TriageWorkbenchState.from_candidates(
        [
            {
                "candidate_id": "cand-a",
                "category": "xss",
                "description": "Raw HTML sink",
                "locations": [{"file": "app/page.tsx", "line": 10}],
                "evidence": ["dangerouslySetInnerHTML receives query"],
            },
            {
                "candidate_id": "cand-b",
                "category": "metadata",
                "description": "Public app title",
                "locations": [],
                "evidence": ["title is public"],
            },
        ]
    )

    state.create_groups(
        groups=[
            {
                "kind": "keep",
                "item_ids": ["cand-a"],
                "category": "xss",
                "summary": "Raw HTML sink uses query input.",
                "evidence": ["dangerouslySetInnerHTML receives query"],
            },
            {
                "kind": "suppress",
                "item_ids": ["cand-b"],
                "reason": "non-security-behavior: public metadata",
            },
        ]
    )

    finish = state.finish()
    assert finish["ok"]
    assert len(finish["cases"]) == 1
    assert finish["cases"][0]["member_candidate_ids"] == ["cand-a"]
    assert finish["suppressed_candidates"][0]["candidate_id"] == "cand-b"


def test_triage_workbench_state_auto_moves_duplicate_assignment() -> None:
    state = TriageWorkbenchState.from_candidates(
        [
            {"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]},
            {"candidate_id": "cand-b", "category": "xss", "evidence": ["b"]},
        ]
    )

    state.create_group(
        kind="keep",
        item_ids=["cand-a", "cand-b"],
        category="xss",
        summary="First group",
        evidence=["a"],
    )
    state.create_group(
        kind="suppress",
        item_ids=["cand-a"],
        reason="duplicate-covered-by-cand-b",
    )

    groups = {group["kind"]: group for group in state.read_groups()["groups"]}
    assert groups["keep"]["item_ids"] == ["cand-b"]
    assert groups["suppress"]["item_ids"] == ["cand-a"]


def test_triage_workbench_state_rejects_unknown_item_ids() -> None:
    state = TriageWorkbenchState.from_candidates(
        [
            {"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]},
        ]
    )

    with pytest.raises(ValueError) as context:
        state.create_group(
            kind="keep",
            item_ids=["cand-a", "missing"],
            category="xss",
            summary="Raw HTML sink uses query input.",
            evidence=["a"],
        )

    assert "unknown item_id(s): missing" in str(context.value)
    assert state.read_groups()["groups"] == []


def test_triage_workbench_state_rejects_incomplete_create_metadata() -> None:
    state = TriageWorkbenchState.from_candidates(
        [
            {"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]},
            {"candidate_id": "cand-b", "category": "metadata", "evidence": ["b"]},
        ]
    )

    with pytest.raises(ValueError) as keep_context:
        state.create_group(
            kind="keep",
            item_ids=["cand-a"],
            summary="Missing fields",
        )

    assert "keep groups require" in str(keep_context.value)

    with pytest.raises(ValueError) as suppress_context:
        state.create_group(kind="suppress", item_ids=["cand-b"])

    assert "suppress groups require reason" in str(suppress_context.value)
    assert state.read_groups()["groups"] == []


def test_triage_workbench_state_rejects_unknown_group_kind_at_mutation_boundary() -> (
    None
):
    state = TriageWorkbenchState.from_candidates(
        [
            {"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]},
            {"candidate_id": "cand-b", "category": "xss", "evidence": ["b"]},
        ]
    )

    with pytest.raises(ValueError) as create_context:
        state.create_group(kind="maybe", item_ids=["cand-a"])

    assert "invalid triage group kind" in str(create_context.value)
    assert state.read_groups()["groups"] == []

    group_id = state.create_group(
        kind="keep",
        item_ids=["cand-a"],
        category="xss",
        summary="Raw HTML sink",
        evidence=["a"],
    )["created_group_ids"][0]

    with pytest.raises(ValueError) as update_context:
        state.update_groups(
            groups=[
                {
                    "group_id": group_id,
                    "summary": "Updated summary",
                },
                {
                    "group_id": group_id,
                    "kind": "maybe",
                },
            ]
        )

    assert "invalid triage group kind" in str(update_context.value)
    assert state.read_groups()["groups"][0]["summary"] == "Raw HTML sink"


def test_triage_tool_schema_rejects_incomplete_create_metadata() -> None:
    state = TriageWorkbenchState.from_candidates(
        [{"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]}]
    )
    tools = {tool.name: tool for tool in build_triage_workbench_tools(state)}

    with pytest.raises(ValueError) as context:
        tools["create_groups"].invoke(
            {
                "groups": [
                    {
                        "kind": "keep",
                        "item_ids": ["cand-a"],
                        "summary": "Missing fields",
                    }
                ]
            }
        )

    assert "keep groups require" in str(context.value)
    assert state.read_groups()["groups"] == []


def test_triage_tool_schema_rejects_unknown_group_kind() -> None:
    state = TriageWorkbenchState.from_candidates(
        [{"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]}]
    )
    tools = {tool.name: tool for tool in build_triage_workbench_tools(state)}

    with pytest.raises(ValueError) as create_context:
        tools["create_groups"].invoke(
            {
                "groups": [
                    {
                        "kind": "maybe",
                        "item_ids": ["cand-a"],
                    }
                ]
            }
        )

    assert "invalid triage group kind" in str(create_context.value)
    assert state.read_groups()["groups"] == []


def test_triage_workbench_state_mutations_return_compact_ack() -> None:
    state = TriageWorkbenchState.from_candidates(
        [
            {"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]},
            {"candidate_id": "cand-b", "category": "xss", "evidence": ["b"]},
        ]
    )

    result = state.create_group(
        kind="keep",
        item_ids=["cand-a"],
        category="xss",
        summary="Raw HTML sink",
        evidence=["dangerouslySetInnerHTML receives query"],
    )

    assert result["operation"] == "create_group"
    assert result["created_group_ids"] == ["group-1"]
    assert result["changed_groups"] == [
        {"group_id": "group-1", "kind": "keep", "item_ids": ["cand-a"]}
    ]
    assert result["constraints"] == {"ok": False, "error_count": 1}
    assert "groups" not in result
    assert "summary" not in result["changed_groups"][0]
    assert "evidence" not in result["changed_groups"][0]

    delete_result = state.delete_group(group_id=result["created_group_ids"][0])

    assert delete_result["operation"] == "delete_group"
    assert delete_result["deleted_group_ids"] == ["group-1"]
    assert delete_result["unprocessed_item_ids"] == ["cand-a"]
    assert delete_result["changed_groups"] == []


def test_triage_workbench_state_rejects_create_time_group_ids() -> None:
    state = TriageWorkbenchState.from_candidates(
        [{"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]}]
    )

    with pytest.raises(ValueError) as context:
        state.create_groups(
            groups=[
                {
                    "group_id": "agent-picked-group",
                    "kind": "keep",
                    "item_ids": ["cand-a"],
                    "category": "xss",
                    "summary": "Raw HTML sink",
                    "evidence": ["dangerouslySetInnerHTML receives query"],
                }
            ]
        )

    assert "Extra inputs are not permitted" in str(context.value)
    assert state.read_groups()["groups"] == []


def test_triage_tools_do_not_expose_item_or_group_detail_reads() -> None:
    state = TriageWorkbenchState.from_candidates(
        [{"candidate_id": "cand-a", "category": "xss", "evidence": ["a"]}]
    )
    tools = {tool.name: tool for tool in build_triage_workbench_tools(state)}

    assert set(tools["check_constraints"].args) == set()
    assert set(tools["read_groups"].args) == set()
    assert "read_group" not in tools
    assert "read_item" not in tools
    assert "read_items" not in tools
