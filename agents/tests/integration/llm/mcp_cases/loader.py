from pathlib import Path

from pydantic import ValidationError

from sec_review_agents.entrypoints.setup_declaration import parse_setup_declaration
from tests.integration.llm.mcp_cases.models import McpCase, McpCaseMode

MCP_CASE_FIXTURES = Path(__file__).with_name("fixtures")


def load_mcp_cases() -> tuple[McpCase, ...]:
    cases: list[McpCase] = []
    seen_ids: set[str] = set()
    for case_path in sorted(MCP_CASE_FIXTURES.glob("*/case.json")):
        try:
            case = McpCase.model_validate_json(case_path.read_text(encoding="utf-8"))
        except ValidationError as exc:
            raise AssertionError(f"invalid MCP case {case_path}: {exc}") from exc
        case._directory = case_path.parent
        if case.id != case_path.parent.name:
            raise AssertionError(
                f"case id {case.id!r} must match directory {case_path.parent.name!r}"
            )
        if case.id in seen_ids:
            raise AssertionError(f"duplicate MCP case id: {case.id}")
        if not case.workspace_source.is_dir():
            raise AssertionError(f"missing workspace for MCP case {case.id}")
        if not case.setup_path.is_file():
            raise AssertionError(f"missing setup declaration for MCP case {case.id}")
        parse_setup_declaration(case.setup_path.read_text(encoding="utf-8"))
        seen_ids.add(case.id)
        cases.append(case)
    if not cases:
        raise AssertionError(f"no MCP cases found under {MCP_CASE_FIXTURES}")
    return tuple(cases)


def cases_for_mode(
    cases: tuple[McpCase, ...], mode: McpCaseMode
) -> tuple[McpCase, ...]:
    return tuple(case for case in cases if mode in case.modes)
