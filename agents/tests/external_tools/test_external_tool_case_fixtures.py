import subprocess
from pathlib import Path

import pytest

from tests.integration.llm.external_tool_cases.loader import (
    cases_for_mode,
    load_external_tool_cases,
)
from tests.integration.llm.external_tool_cases.models import GitCheckoutSource
from tests.integration.llm.external_tool_cases.runner import (
    assert_external_tool_case_oracles,
    has_required_external_tool_evidence,
    materialize_external_tool_case_workspace,
)


def test_external_tool_case_fixtures_are_valid_and_cover_each_tool_twice() -> None:
    cases = load_external_tool_cases()

    assert sum(case.tool == "joern" for case in cases) >= 2
    assert sum(case.tool == "playwright" for case in cases) >= 2
    for case in cases:
        if case.checkout is None:
            assert any(case.workspace_source.iterdir()), case.id


def test_external_tool_compare_cases_use_pinned_remote_checkouts() -> None:
    cases = cases_for_mode(load_external_tool_cases(), "compare")

    assert cases
    for case in cases:
        assert case.checkout is not None
        assert len(case.checkout.commit) == 40
        assert case.oracles.comparison_evidence_patterns


def test_external_tool_oracle_binds_command_and_evidence_to_one_execution() -> None:
    case = next(
        case
        for case in load_external_tool_cases()
        if case.id == "playwright-reflected-xss"
    )
    observation = {
        "toolInteractions": [
            {
                "tool": "execute",
                "arguments": {"command": "playwright cli eval document.title"},
                "result": "No execution marker",
            },
            {
                "tool": "execute",
                "arguments": {"command": "printf unrelated"},
                "result": "CLI_REFLECTED_XSS_EXECUTED",
            },
        ],
        "result": {
            "validation_level": "runtime-endpoint",
            "verification_findings": ["Reflected XSS execution confirmed"],
        },
    }

    with pytest.raises(AssertionError):
        assert_external_tool_case_oracles(case, observation)


def test_external_tool_availability_probe_is_not_tool_evidence() -> None:
    case = next(
        case for case in load_external_tool_cases() if case.id == "sftpgo-rsync-command"
    )
    observation = {
        "toolInteractions": [
            {
                "tool": "execute",
                "arguments": {"command": "which joern joern-parse"},
                "result": "[Command failed with exit code 1]",
            }
        ]
    }

    assert not has_required_external_tool_evidence(case, observation)


def test_external_tool_workspace_materialization_preserves_dangling_symlinks(
    tmp_path,
) -> None:
    case = next(
        case for case in load_external_tool_cases() if case.id == "joern-source-to-sink"
    ).model_copy(deep=True)
    case._directory = tmp_path / "case"
    case.workspace_source.mkdir(parents=True)
    (case.workspace_source / "dangling").symlink_to("missing-target")

    destination = tmp_path / "materialized"
    materialize_external_tool_case_workspace(case, destination)

    assert (destination / "dangling").is_symlink()
    assert (destination / "dangling").readlink() == Path("missing-target")


def test_external_tool_checkout_materializes_only_the_pinned_revision(tmp_path) -> None:
    repository = tmp_path / "repository"
    repository.mkdir()
    subprocess.run(["git", "init", "--quiet"], cwd=repository, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=repository,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=repository,
        check=True,
    )
    (repository / "evidence.txt").write_text("pinned\n", encoding="utf-8")
    subprocess.run(["git", "add", "evidence.txt"], cwd=repository, check=True)
    subprocess.run(
        ["git", "commit", "--quiet", "-m", "pinned"],
        cwd=repository,
        check=True,
    )
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    case = next(
        case for case in load_external_tool_cases() if case.id == "joern-source-to-sink"
    ).model_copy(deep=True)
    case.checkout = GitCheckoutSource(repository=str(repository), commit=commit)

    destination = tmp_path / "checkout"
    materialize_external_tool_case_workspace(case, destination)

    assert (destination / "evidence.txt").read_text(encoding="utf-8") == "pinned\n"
    assert not (destination / ".git").exists()
