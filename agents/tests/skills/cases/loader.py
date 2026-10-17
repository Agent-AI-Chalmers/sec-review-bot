from pathlib import Path

from pydantic import ValidationError

from sec_review_agents.resources.paths import AGENT_SKILLS
from tests.integration.llm.skill_cases.models import SkillCase, SkillCaseMode

SKILL_CASE_FIXTURES = Path(__file__).with_name("fixtures")


def load_skill_cases() -> tuple[SkillCase, ...]:
    cases = []
    seen_ids = set()
    for case_path in sorted(SKILL_CASE_FIXTURES.glob("*/case.json")):
        try:
            case = SkillCase.model_validate_json(case_path.read_text(encoding="utf-8"))
        except ValidationError as exc:
            raise AssertionError(f"invalid skill case {case_path}: {exc}") from exc
        case._directory = case_path.parent
        if case.id != case_path.parent.name:
            raise AssertionError(
                f"case id {case.id!r} must match directory {case_path.parent.name!r}"
            )
        if case.id in seen_ids:
            raise AssertionError(f"duplicate skill case id: {case.id}")
        seen_ids.add(case.id)
        skill_file = AGENT_SKILLS / case.skill / "SKILL.md"
        reference_file = AGENT_SKILLS / case.skill / "references" / case.reference
        if not skill_file.is_file():
            raise AssertionError(f"unknown skill for {case.id}: {case.skill}")
        if not reference_file.is_file():
            raise AssertionError(
                f"unknown reference for {case.id}: {case.reference_path}"
            )
        cases.append(case)
    if not cases:
        raise AssertionError(f"no skill cases found under {SKILL_CASE_FIXTURES}")
    return tuple(cases)


def cases_for_mode(
    cases: tuple[SkillCase, ...], mode: SkillCaseMode
) -> tuple[SkillCase, ...]:
    return tuple(case for case in cases if mode in case.modes)
