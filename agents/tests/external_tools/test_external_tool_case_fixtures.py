import pytest

from tests.integration.llm.external_tool_cases.loader import load_external_tool_cases
from tests.integration.llm.external_tool_cases.runner import (
    assert_external_tool_case_oracles,
)


def test_external_tool_case_fixtures_are_valid_and_cover_each_tool_twice() -> None:
    cases = load_external_tool_cases()

    assert sum(case.tool == "joern" for case in cases) >= 2
    assert sum(case.tool == "playwright" for case in cases) >= 2
    for case in cases:
        assert any(case.workspace_source.iterdir()), case.id


def test_external_tool_oracle_binds_command_and_evidence_to_one_execution() -> None:
    case = next(
        case
        for case in load_external_tool_cases()
        if case.id == "playwright-reflected-xss"
    )
    observation = {
        "toolInteractions": [
            {
                "tool": "execute",
                "arguments": {"command": "playwright cli eval document.title"},
                "result": "No execution marker",
            },
            {
                "tool": "execute",
                "arguments": {"command": "printf unrelated"},
                "result": "CLI_REFLECTED_XSS_EXECUTED",
            },
        ],
        "result": {
            "validation_level": "runtime-endpoint",
            "verification_findings": ["Reflected XSS execution confirmed"],
        },
    }

    with pytest.raises(AssertionError):
        assert_external_tool_case_oracles(case, observation)
