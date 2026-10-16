from pathlib import Path
from unittest.mock import patch

import pytest

import sec_review_agents.runtime.skills as runtime_skills
from sec_review_agents.runtime.skills import materialize_agent_skills_view


@pytest.fixture(autouse=True)
def reset_default_skills_materialized_root():
    runtime_skills._DEFAULT_SKILLS_MATERIALIZED_ROOT = None
    yield
    runtime_skills._DEFAULT_SKILLS_MATERIALIZED_ROOT = None


def test_materialize_agent_skills_view_uses_declared_view_shape(tmp_path: Path) -> None:
    with (
        patch(
            "sec_review_agents.runtime.skills.tempfile.mkdtemp",
            side_effect=[
                str(tmp_path / "skills-base-root"),
                str(tmp_path / "skills-build-1"),
            ],
        ),
    ):
        skills_root = materialize_agent_skills_view(
            ("cwe", "web-security", "ci-security"),
        )

    assert skills_root.parent == (tmp_path / "skills-base-root").resolve()
    assert skills_root.name.startswith("skills-")
    assert (skills_root / "cwe" / "SKILL.md").is_file()
    assert (
        skills_root / "cwe" / "references" / "cwe-699-agent-navigation.md"
    ).is_file()
    assert (skills_root / "web-security" / "SKILL.md").is_file()
    assert (skills_root / "ci-security" / "SKILL.md").is_file()
    assert not (skills_root / "skill_source_notes").exists()


def test_materialize_agent_skills_view_rebuilds_view_from_declaration(
    tmp_path: Path,
) -> None:
    with patch(
        "sec_review_agents.runtime.skills.tempfile.mkdtemp",
        side_effect=[
            str(tmp_path / "skills-base-root"),
            str(tmp_path / "skills-build-1"),
            str(tmp_path / "skills-build-2"),
        ],
    ):
        skills_root = materialize_agent_skills_view(("cwe",))
        (skills_root / "stale-skill").mkdir()
        (skills_root / "stale-skill" / "SKILL.md").write_text(
            "stale",
            encoding="utf-8",
        )
        manifest = next(skills_root.parent.glob(".*.manifest"))
        manifest.unlink()
        skills_root = materialize_agent_skills_view(("cwe",))

    assert (skills_root / "cwe" / "SKILL.md").is_file()
    assert not (skills_root / "stale-skill").exists()


def test_materialize_agent_skills_view_includes_reference_skills(
    tmp_path: Path,
) -> None:
    with patch(
        "sec_review_agents.runtime.skills.tempfile.mkdtemp",
        side_effect=[
            str(tmp_path / "skills-base-root"),
            str(tmp_path / "skills-build-1"),
        ],
    ):
        skills_root = materialize_agent_skills_view(
            (
                "web-security",
                "ci-security",
                "scanner-finding-triage",
                "memory-numeric-safety",
                "cryptography-security",
                "concurrency-resource-security",
                "os-boundary-security",
                "parser-protocol-security",
            ),
        )

    assert (skills_root / "web-security" / "SKILL.md").is_file()
    assert (skills_root / "web-security" / "references" / "access-control.md").is_file()
    assert (skills_root / "web-security" / "references" / "auth-session.md").is_file()
    assert (skills_root / "web-security" / "references" / "ssrf.md").is_file()
    assert (skills_root / "web-security" / "references" / "sql-injection.md").is_file()
    assert (skills_root / "web-security" / "references" / "csrf.md").is_file()
    assert (skills_root / "web-security" / "references" / "file-upload.md").is_file()
    assert (
        skills_root / "web-security" / "references" / "sensitive-data-exposure.md"
    ).is_file()
    assert (skills_root / "web-security" / "references" / "xss.md").is_file()
    assert (skills_root / "ci-security" / "SKILL.md").is_file()
    assert (skills_root / "ci-security" / "references" / "github-actions.md").is_file()
    assert (skills_root / "ci-security" / "references" / "gitlab-ci.md").is_file()
    assert (
        skills_root / "ci-security" / "references" / "secret-and-artifact-exposure.md"
    ).is_file()
    assert (skills_root / "scanner-finding-triage" / "SKILL.md").is_file()
    scanner_references = skills_root / "scanner-finding-triage" / "references"
    assert (scanner_references / "reachability-and-context.md").is_file()
    assert (scanner_references / "scanner-noise-patterns.md").is_file()
    assert (skills_root / "memory-numeric-safety" / "SKILL.md").is_file()
    assert (skills_root / "cryptography-security" / "SKILL.md").is_file()
    assert (skills_root / "concurrency-resource-security" / "SKILL.md").is_file()
    assert (skills_root / "os-boundary-security" / "SKILL.md").is_file()
    assert (
        skills_root
        / "os-boundary-security"
        / "references"
        / "process-execution-input.md"
    ).is_file()
    assert (
        skills_root
        / "os-boundary-security"
        / "references"
        / "filesystem-path-policy.md"
    ).is_file()
    assert (skills_root / "parser-protocol-security" / "SKILL.md").is_file()
    assert (
        skills_root
        / "parser-protocol-security"
        / "references"
        / "object-construction.md"
    ).is_file()
    assert not (skills_root / "skill_source_notes").exists()


def test_materialized_view_contains_only_declared_skill_resources() -> None:
    """Source notes remain outside the view, regardless of their wording or URLs."""
    declared = (
        "cwe",
        "web-security",
        "ci-security",
        "scanner-finding-triage",
        "memory-numeric-safety",
        "cryptography-security",
        "concurrency-resource-security",
        "os-boundary-security",
        "parser-protocol-security",
    )
    skills_root = materialize_agent_skills_view(declared)
    assert {path.name for path in skills_root.iterdir()} == set(declared)
    expected = {}
    for name in declared:
        source = runtime_skills.AGENT_SKILLS / name
        expected[f"{name}/SKILL.md"] = (source / "SKILL.md").read_bytes()
        for reference in (source / "references").iterdir():
            expected[f"{name}/references/{reference.name}"] = reference.read_bytes()
    actual = {
        str(path.relative_to(skills_root)): path.read_bytes()
        for path in skills_root.rglob("*")
        if path.is_file()
    }
    assert actual == expected
