import pytest

from tests.integration.llm.probe_helpers import llm_probe
from tests.integration.llm.skill_cases.loader import cases_for_mode, load_skill_cases
from tests.integration.llm.skill_cases.runner import (
    assert_case_oracles,
    assert_discovery_read,
    assert_prompted_read,
    run_skill_case,
)

CASES = load_skill_cases()
PROBE = llm_probe(
    run_env="RUN_LLM_SKILL_CASES",
    description="data-driven bundled skill cases",
)

pytestmark = [PROBE.skip_unless(), pytest.mark.asyncio]


@pytest.mark.parametrize(
    "case",
    cases_for_mode(CASES, "prompted"),
    ids=lambda case: case.id,
)
async def test_prompted_skill_cases(tmp_path, case) -> None:
    run = await run_skill_case(
        case,
        mode="prompted",
        skills_enabled=True,
        temp_root=tmp_path,
    )
    assert_prompted_read(case, run)
    assert_case_oracles(case, run)


@pytest.mark.parametrize(
    "case",
    cases_for_mode(CASES, "discovery"),
    ids=lambda case: case.id,
)
async def test_discovery_skill_cases(tmp_path, case) -> None:
    run = await run_skill_case(
        case,
        mode="discovery",
        skills_enabled=True,
        temp_root=tmp_path,
    )
    assert_discovery_read(case, run)
    assert_case_oracles(case, run)


@pytest.mark.parametrize(
    "case",
    cases_for_mode(CASES, "contrast"),
    ids=lambda case: case.id,
)
async def test_skill_case_contrast(tmp_path, case) -> None:
    without_skills = await run_skill_case(
        case,
        mode="contrast",
        skills_enabled=False,
        temp_root=tmp_path / "without-skills",
    )
    with_skills = await run_skill_case(
        case,
        mode="contrast",
        skills_enabled=True,
        temp_root=tmp_path / "with-skills",
    )

    assert not any(
        path.startswith("/skills/") for path in without_skills.successful_reads
    )
    assert_discovery_read(case, with_skills)
    assert_case_oracles(case, with_skills)
    print(
        {
            "case": case.id,
            "without_skills": without_skills.output.model_dump(),
            "with_skills": with_skills.output.model_dump(),
            "with_skills_reads": sorted(with_skills.successful_reads),
        }
    )
