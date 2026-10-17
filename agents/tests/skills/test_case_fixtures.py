from tests.skills.cases.loader import cases_for_mode, load_skill_cases


def test_skill_case_fixtures_are_valid_and_cover_each_mode() -> None:
    cases = load_skill_cases()
    assert cases_for_mode(cases, "prompted")
    assert cases_for_mode(cases, "discovery")
    assert cases_for_mode(cases, "compare")

    for case in cases:
        if case.workspace_source.is_dir():
            files = [
                path for path in case.workspace_source.rglob("*") if path.is_file()
            ]
            assert files, case.id
            assert all(path.is_relative_to(case.workspace_source) for path in files)
