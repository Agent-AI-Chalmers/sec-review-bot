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
from sec_review_agents.resources.loader import load_prompt_resource
from sec_review_agents.workflows.review_intent import REPAIR_MODE_TEST_CHANGES_ALLOWED


def _joined_prompt_resources(*paths: str) -> str:
    return "\n\n".join(load_prompt_resource(path) for path in paths)


def test_prompt_resource_loader_normalizes_only_trailing_newlines() -> None:
    """Keep prompt boundaries stable without stripping Markdown indentation."""
    resource = load_prompt_resource("memory/maintain-system.md")

    assert not resource.endswith("\n")
    assert resource.startswith("You maintain")


def test_initial_verifier_prompt_uses_initial_delta_only() -> None:
    """Do not expose retry instructions before a verifier retry exists."""
    prompt = build_issue_verification_system_prompt()

    assert load_prompt_resource("verifier/system-initial-delta.md") in prompt
    assert load_prompt_resource("verifier/system-retry-delta.md") not in prompt


def test_retry_verifier_prompt_uses_retry_delta_only() -> None:
    """A retry must replace, rather than accumulate, initial-only instructions."""
    prompt = build_issue_verification_system_prompt(is_retry=True)

    assert load_prompt_resource("verifier/system-retry-delta.md") in prompt
    assert load_prompt_resource("verifier/system-initial-delta.md") not in prompt


def test_non_verifier_retry_delta_prompt_still_loads_role_retry_delta() -> None:
    """Keep the retry delta ahead of scope-specific mitigation instructions."""
    prompt = build_issue_mitigation_system_prompt(is_retry=True)

    retry_delta = load_prompt_resource("mitigator/system-retry-delta.md")
    scope_delta = load_prompt_resource("scopes/issue/mitigator/system-delta.md")
    assert prompt.index(retry_delta) < prompt.index(scope_delta)


def test_mitigation_retry_profiles_include_retry_delta() -> None:
    """All mitigation scopes must receive the same retry-only contract."""
    prompts = [
        build_issue_mitigation_system_prompt(is_retry=True),
        build_pr_mitigation_system_prompt(is_retry=True),
        build_repository_mitigation_system_prompt(is_retry=True),
    ]

    for prompt in prompts:
        assert load_prompt_resource("mitigator/system-retry-delta.md") in prompt


def test_initial_mitigation_profiles_do_not_include_retry_delta() -> None:
    """Initial mitigation runs must not inherit retry-only context."""
    prompts = [
        build_issue_mitigation_system_prompt(),
        build_pr_mitigation_system_prompt(),
        build_repository_mitigation_system_prompt(),
    ]

    for prompt in prompts:
        assert load_prompt_resource("mitigator/system-retry-delta.md") not in prompt


def test_mitigation_profiles_include_test_change_boundary() -> None:
    """Propagate the caller's no-test-changes policy to every mitigation path."""
    prompts = [
        build_issue_mitigation_system_prompt(repair_mode="no-test-changes"),
        build_issue_self_check_mitigation_system_prompt(repair_mode="no-test-changes"),
        build_pr_mitigation_system_prompt(repair_mode="no-test-changes"),
        build_repository_mitigation_system_prompt(repair_mode="no-test-changes"),
    ]

    for prompt in prompts:
        assert (
            load_prompt_resource("repair-modes/no-test-changes-boundary.md") in prompt
        )
        assert (
            load_prompt_resource("repair-modes/test-changes-allowed-boundary.md")
            not in prompt
        )


def test_repair_capable_prompts_include_git_history_boundary() -> None:
    """Every patch-producing role must receive the shared history boundary."""
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
        assert (
            load_prompt_resource("shared/no-git-history-remediation-boundary.md")
            in prompt
        )


def test_analyzer_and_verifier_prompts_include_advisory_evidence_rule() -> None:
    """Roles that judge evidence must share the advisory provenance rule."""
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
        assert load_prompt_resource("shared/advisory-evidence-rule.md") in prompt


def test_review_agent_prompts_end_with_output_formatting() -> None:
    """Keep formatting last so later role or scope deltas cannot supersede it."""
    prompts = [
        build_issue_analyzer_system_prompt("audit"),
        build_pr_analyzer_system_prompt(),
        build_repository_analyzer_system_prompt(),
        build_issue_mitigation_system_prompt(),
        build_issue_self_check_mitigation_system_prompt(),
        build_pr_mitigation_system_prompt(),
        build_repository_mitigation_system_prompt(),
        build_issue_verification_system_prompt(),
        build_pr_verification_system_prompt(),
        build_repository_verification_system_prompt(),
        build_issue_single_agent_system_prompt(
            review_objective="audit",
            repair_mode=REPAIR_MODE_TEST_CHANGES_ALLOWED,
        ),
    ]

    for prompt in prompts:
        formatting = load_prompt_resource("shared/output-formatting.md")
        assert prompt.endswith(formatting)
        assert prompt.count(formatting) == 1


def test_filesystem_prompts_bound_git_exploration() -> None:
    """Compose each filesystem prompt from its role core and issue delta."""
    prompt_resources = [
        (
            build_issue_analyzer_filesystem_system_prompt(),
            "analyzer/filesystem-system-core.md",
            "scopes/issue/analyzer/filesystem-system-delta.md",
        ),
        (
            build_issue_single_agent_filesystem_system_prompt(),
            "single-agent/filesystem-system-core.md",
            "scopes/issue/single-agent/filesystem-system-delta.md",
        ),
        (
            build_issue_verification_filesystem_system_prompt(),
            "verifier/filesystem-system-core.md",
            "scopes/issue/verifier/filesystem-system-delta.md",
        ),
    ]

    for prompt, core_path, delta_path in prompt_resources:
        assert prompt == _joined_prompt_resources(core_path, delta_path)


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
