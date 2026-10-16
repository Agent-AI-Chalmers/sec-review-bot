from sec_review_agents.resources.paths import AGENT_SKILLS
from tests.integration.llm.skill_cases.loader import cases_for_mode, load_skill_cases


def test_skill_case_fixtures_are_valid_and_cover_each_mode() -> None:
    cases = load_skill_cases()
    assert cases_for_mode(cases, "prompted")
    assert cases_for_mode(cases, "natural")
    assert cases_for_mode(cases, "contrast")

    for case in cases:
        if case.workspace_source.is_dir():
            files = [
                path for path in case.workspace_source.rglob("*") if path.is_file()
            ]
            assert files, case.id
            assert all(path.is_relative_to(case.workspace_source) for path in files)


def test_domain_references_have_behavior_cases() -> None:
    """A bundled domain reference needs at least one maintained model oracle."""
    cases = load_skill_cases()
    covered = {(case.skill, case.reference) for case in cases}
    uncovered = set()
    for skill_dir in AGENT_SKILLS.iterdir():
        if not skill_dir.is_dir() or skill_dir.name == "scanner-finding-triage":
            continue
        references = skill_dir / "references"
        if not references.is_dir():
            continue
        for reference in references.iterdir():
            if not reference.is_file() or not reference.name.endswith(".md"):
                continue
            key = (skill_dir.name, reference.name)
            if key not in covered:
                uncovered.add(key)

    assert not uncovered, sorted(uncovered)
