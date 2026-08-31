from sec_review_agents.agents.analysis.issue import (
    build_issue_analyzer_filesystem_system_prompt,
    build_issue_analyzer_system_prompt,
)
from sec_review_agents.agents.analysis.pull_request import (
    build_pr_analyzer_system_prompt,
)
from sec_review_agents.agents.analysis.repository import (
    build_repository_analyzer_filesystem_system_prompt,
    build_repository_analyzer_system_prompt,
)
from sec_review_agents.agents.mitigation.issue import (
    build_issue_mitigation_system_prompt,
    build_issue_self_check_mitigation_system_prompt,
)
from sec_review_agents.agents.mitigation.pull_request import (
    build_pr_mitigation_system_prompt,
)
from sec_review_agents.agents.mitigation.repository import (
    build_repository_mitigation_filesystem_system_prompt,
    build_repository_mitigation_system_prompt,
)
from sec_review_agents.agents.single_agent.issue import (
    build_issue_single_agent_filesystem_system_prompt,
    build_issue_single_agent_system_prompt,
)
from sec_review_agents.agents.verification.issue import (
    build_issue_verification_filesystem_system_prompt,
    build_issue_verification_system_prompt,
)
from sec_review_agents.agents.verification.pull_request import (
    build_pr_verification_system_prompt,
)
from sec_review_agents.agents.verification.repository import (
    build_repository_verification_filesystem_system_prompt,
    build_repository_verification_system_prompt,
)
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED


def test_initial_verifier_prompt_uses_initial_delta_only() -> None:
    prompt = build_issue_verification_system_prompt()

    assert "# Initial Verification Delta" in prompt
    assert "the strongest repository-grounded claim you can currently support" in prompt
    assert "`defendedClaim`" not in prompt
    assert "# Retry Verification Delta" not in prompt
    assert "`carriedForwardClaim`" not in prompt


def test_retry_verifier_prompt_uses_retry_delta_only() -> None:
    prompt = build_issue_verification_system_prompt(is_retry=True)

    assert "# Retry Verification Delta" in prompt
    assert "the previous verifier's reviewed claim" in prompt
    assert "the previous blocking concern" in prompt
    assert "`carriedForwardClaim`" not in prompt
    assert "`blockingConcern`" not in prompt
    assert "# Initial Verification Delta" not in prompt
    assert "`defendedClaim`" not in prompt


def test_non_verifier_retry_delta_prompt_still_loads_role_retry_delta() -> None:
    prompt = build_issue_mitigation_system_prompt(is_retry=True)

    assert "# Retry Delta" in prompt
    assert prompt.index("# Retry Delta") < prompt.index("# Issue Scope")


def test_mitigation_retry_profiles_include_retry_delta() -> None:
    prompts = [
        build_issue_mitigation_system_prompt(is_retry=True),
        build_pr_mitigation_system_prompt(is_retry=True),
        build_repository_mitigation_system_prompt(is_retry=True),
    ]

    for prompt in prompts:
        assert "# Retry Delta" in prompt


def test_initial_mitigation_profiles_do_not_include_retry_delta() -> None:
    prompts = [
        build_issue_mitigation_system_prompt(),
        build_pr_mitigation_system_prompt(),
        build_repository_mitigation_system_prompt(),
    ]

    for prompt in prompts:
        assert "# Retry Delta" not in prompt


def test_mitigation_profiles_include_test_change_boundary() -> None:
    prompts = [
        build_issue_mitigation_system_prompt(repair_mode="no-test-changes"),
        build_issue_self_check_mitigation_system_prompt(repair_mode="no-test-changes"),
        build_pr_mitigation_system_prompt(repair_mode="no-test-changes"),
        build_repository_mitigation_system_prompt(repair_mode="no-test-changes"),
    ]

    for prompt in prompts:
        assert "# No-Test-Changes Boundary" in prompt
        assert "# Test-Changes-Allowed Boundary" not in prompt


def test_repair_capable_prompts_include_git_history_boundary() -> None:
    prompts = [
        build_issue_mitigation_system_prompt(),
        build_issue_self_check_mitigation_system_prompt(),
        build_pr_mitigation_system_prompt(),
        build_repository_mitigation_system_prompt(),
        build_issue_single_agent_system_prompt(
            review_objective="audit",
            repair_mode=REPAIR_MODE_TEST_CHANGES_ALLOWED,
        ),
        build_issue_verification_system_prompt(),
        build_pr_verification_system_prompt(),
        build_repository_verification_system_prompt(),
    ]

    for prompt in prompts:
        assert "# Git History Remediation Boundary" in prompt
        assert "do not claim full automatic remediation" in prompt


def test_analyzer_and_verifier_prompts_include_advisory_evidence_rule() -> None:
    prompts = [
        build_issue_analyzer_system_prompt("audit"),
        build_pr_analyzer_system_prompt(),
        build_repository_analyzer_system_prompt(),
        build_issue_verification_system_prompt(),
        build_issue_verification_system_prompt(is_retry=True),
        build_pr_verification_system_prompt(),
        build_pr_verification_system_prompt(is_retry=True),
        build_repository_verification_system_prompt(),
        build_repository_verification_system_prompt(is_retry=True),
    ]

    for prompt in prompts:
        assert "# Advisory Evidence Rule" in prompt
        assert "external advisories as external facts" in prompt
        assert "not automatically local workspace evidence" in prompt


def test_analyzer_prompts_treat_existing_mitigation_as_coverage_not_verdict() -> None:
    prompts = [
        build_issue_analyzer_system_prompt("audit"),
        build_pr_analyzer_system_prompt(),
        build_repository_analyzer_system_prompt(),
    ]

    for prompt in prompts:
        assert "investigated signal as a serious current-code hypothesis" in prompt
        assert "narrow or reject it only when checked repository evidence" in prompt
        assert (
            "Do not reject an investigated signal only because current code" in prompt
        )
        assert "When you find such an existing mitigation" in prompt
        assert "the mitigation may be partial" in prompt
        assert "may make the older mitigation insufficient" in prompt
        assert "what reachable asset or operation it controls" in prompt
        assert "what it does not prove" in prompt


def test_filesystem_prompts_bound_git_exploration() -> None:
    prompts = [
        build_issue_analyzer_filesystem_system_prompt(),
        build_issue_single_agent_filesystem_system_prompt(),
        build_issue_verification_filesystem_system_prompt(),
    ]

    for prompt in prompts:
        assert "## Git Metadata" in prompt
        assert "use at most 5 git commands" not in prompt
        assert "Treat git usage as scarce" not in prompt
        assert "Do not spend git commands just because `.git` is present" in prompt
        assert "A git history command is exceptional" in prompt
        assert "Do not use broad history exploration commands" in prompt
        assert "Do not mutate the source working tree" in prompt
        assert "A CVE, advisory, or fixed commit ref alone is not enough" in prompt


def test_repository_incremental_evidence_prompt_is_incremental_only() -> None:
    prompt_cases = [
        (build_repository_analyzer_filesystem_system_prompt, "full", "incremental"),
        (build_repository_mitigation_filesystem_system_prompt, "full", "incremental"),
        (
            build_repository_verification_filesystem_system_prompt,
            "full",
            "incremental",
        ),
    ]

    for build_prompt, full_input, incremental_input in prompt_cases:
        assert "Incremental Evidence Rule" not in build_prompt(full_input)
        assert "Incremental Evidence Rule" in build_prompt(incremental_input)
