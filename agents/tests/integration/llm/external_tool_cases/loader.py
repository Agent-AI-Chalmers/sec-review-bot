from pathlib import Path

from pydantic import ValidationError

from sec_review_agents.entrypoints.setup_declaration import parse_setup_declaration
from tests.integration.llm.external_tool_cases.models import ExternalToolCase

EXTERNAL_TOOL_CASE_FIXTURES = Path(__file__).with_name("fixtures")


def load_external_tool_cases() -> tuple[ExternalToolCase, ...]:
    cases: list[ExternalToolCase] = []
    seen_ids: set[str] = set()
    for case_path in sorted(EXTERNAL_TOOL_CASE_FIXTURES.glob("*/case.json")):
        try:
            case = ExternalToolCase.model_validate_json(
                case_path.read_text(encoding="utf-8")
            )
        except ValidationError as exc:
            raise AssertionError(
                f"invalid external tool case {case_path}: {exc}"
            ) from exc
        case._directory = case_path.parent
        if case.id != case_path.parent.name:
            raise AssertionError(
                f"case id {case.id!r} must match directory {case_path.parent.name!r}"
            )
        if case.id in seen_ids:
            raise AssertionError(f"duplicate external tool case id: {case.id}")
        if not case.workspace_source.is_dir():
            raise AssertionError(f"missing workspace for external tool case {case.id}")
        if case.setup_path is not None:
            if not case.setup_path.is_file():
                raise AssertionError(f"missing setup declaration for {case.id}")
            parse_setup_declaration(case.setup_path.read_text(encoding="utf-8"))
        seen_ids.add(case.id)
        cases.append(case)
    if not cases:
        raise AssertionError(
            f"no external tool cases found under {EXTERNAL_TOOL_CASE_FIXTURES}"
        )
    return tuple(cases)
