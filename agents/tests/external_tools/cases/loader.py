from pathlib import Path

from pydantic import ValidationError

from sec_review_agents.entrypoints.setup_declaration import parse_setup_declaration
from tests.external_tools.cases.models import (
    ExternalToolCase,
    ExternalToolCaseMode,
)

EXTERNAL_TOOL_CASES = Path(__file__).parent


def load_external_tool_cases() -> tuple[ExternalToolCase, ...]:
    cases: list[ExternalToolCase] = []
    seen_ids: set[str] = set()
    for case_path in sorted(EXTERNAL_TOOL_CASES.glob("*/case.json")):
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
        if case.checkout is None and not case.workspace_source.is_dir():
            raise AssertionError(f"missing workspace for external tool case {case.id}")
        if case.checkout is not None and case.workspace_source.exists():
            raise AssertionError(
                f"external tool case {case.id} cannot have checkout and workspace"
            )
        agent_modes = [
            agent_case
            for agent_case in (case.discovery, case.compare)
            if agent_case is not None
        ]
        if case.setup_path is not None and any(
            agent_case.workflow == "analysis" for agent_case in agent_modes
        ):
            raise AssertionError(f"analysis case {case.id} cannot declare setup")
        if case.setup_path is not None:
            if not case.setup_path.is_file():
                raise AssertionError(f"missing setup declaration for {case.id}")
            parse_setup_declaration(case.setup_path.read_text(encoding="utf-8"))
        seen_ids.add(case.id)
        cases.append(case)
    if not cases:
        raise AssertionError(
            f"no external tool cases found under {EXTERNAL_TOOL_CASES}"
        )
    return tuple(cases)


def cases_for_mode(
    cases: tuple[ExternalToolCase, ...], mode: ExternalToolCaseMode
) -> tuple[ExternalToolCase, ...]:
    return tuple(case for case in cases if mode in case.modes)
