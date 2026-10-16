import pytest

from tests.integration.llm.mcp_cases.loader import cases_for_mode, load_mcp_cases
from tests.integration.llm.mcp_cases.runner import assert_mcp_case_oracles


def test_mcp_case_fixtures_are_valid() -> None:
    cases = load_mcp_cases()
    assert cases_for_mode(cases, "discovery")
    assert cases_for_mode(cases, "compare")
    for case in cases:
        files = [path for path in case.workspace_source.rglob("*") if path.is_file()]
        assert files, case.id
        assert all(path.is_relative_to(case.workspace_source) for path in files)


def test_mcp_oracle_requires_arguments_and_result_from_one_interaction() -> None:
    case = next(case for case in load_mcp_cases() if case.id == "playwright-dom-xss")
    observation = {
        "toolInteractions": [
            {
                "tool": "playwright_browser_navigate",
                "arguments": {"url": "MCP_DOM_XSS_EXECUTED"},
                "result": "page loaded without a dialog",
            },
            {
                "tool": "playwright_browser_navigate",
                "arguments": {"url": "unrelated"},
                "result": 'alert dialog with message "MCP_DOM_XSS_EXECUTED"',
            },
        ],
        "toolErrors": [],
        "result": {
            "validation_level": "runtime-endpoint",
            "verification_findings": ["DOM XSS execution confirmed"],
        },
    }

    with pytest.raises(AssertionError):
        assert_mcp_case_oracles(case, observation)
