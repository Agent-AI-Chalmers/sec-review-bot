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
            ("cwe", "web-security", "ci-security", "language-framework-security"),
        )

    assert skills_root.parent == (tmp_path / "skills-base-root").resolve()
    assert skills_root.name.startswith("skills-")
    assert (skills_root / "cwe" / "SKILL.md").is_file()
    assert (
        skills_root / "cwe" / "references" / "cwe-699-agent-navigation.md"
    ).is_file()
    assert (skills_root / "web-security" / "SKILL.md").is_file()
    assert (skills_root / "ci-security" / "SKILL.md").is_file()
    assert (skills_root / "language-framework-security" / "SKILL.md").is_file()
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
                "language-framework-security",
                "scanner-finding-triage",
            ),
        )

    assert (skills_root / "web-security" / "SKILL.md").is_file()
    assert (skills_root / "web-security" / "references" / "access-control.md").is_file()
    assert (skills_root / "web-security" / "references" / "auth-session.md").is_file()
    assert (skills_root / "web-security" / "references" / "ssrf.md").is_file()
    assert (skills_root / "web-security" / "references" / "sql-injection.md").is_file()
    assert (
        skills_root / "web-security" / "references" / "command-injection.md"
    ).is_file()
    assert (skills_root / "web-security" / "references" / "csrf.md").is_file()
    assert (skills_root / "web-security" / "references" / "file-upload.md").is_file()
    assert (
        skills_root / "web-security" / "references" / "secrets-exposure.md"
    ).is_file()
    assert (skills_root / "web-security" / "references" / "xss.md").is_file()
    assert (skills_root / "web-security" / "references" / "path-traversal.md").is_file()
    assert (
        skills_root / "web-security" / "references" / "deserialization.md"
    ).is_file()
    assert (skills_root / "ci-security" / "SKILL.md").is_file()
    assert (skills_root / "ci-security" / "references" / "github-actions.md").is_file()
    assert (skills_root / "ci-security" / "references" / "gitlab-ci.md").is_file()
    assert (skills_root / "language-framework-security" / "SKILL.md").is_file()
    language_references = skills_root / "language-framework-security" / "references"
    assert (language_references / "go-backend.md").is_file()
    assert (language_references / "python-django.md").is_file()
    assert (language_references / "python-fastapi.md").is_file()
    assert (language_references / "python-flask.md").is_file()
    assert (language_references / "javascript-express.md").is_file()
    assert (language_references / "javascript-frontend.md").is_file()
    assert (language_references / "javascript-jquery.md").is_file()
    assert (language_references / "javascript-typescript-nextjs.md").is_file()
    assert (language_references / "javascript-typescript-react.md").is_file()
    assert (language_references / "javascript-typescript-vue.md").is_file()
    assert (skills_root / "scanner-finding-triage" / "SKILL.md").is_file()
    scanner_references = skills_root / "scanner-finding-triage" / "references"
    assert (scanner_references / "reachability-and-context.md").is_file()
    assert (scanner_references / "scanner-noise-patterns.md").is_file()
    assert not (skills_root / "skill_source_notes").exists()


def test_materialized_reference_skills_do_not_expose_source_notes(
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
            ("web-security", "ci-security", "language-framework-security"),
        )

    for reference_path in (skills_root / "web-security" / "references").glob("*.md"):
        reference_text = reference_path.read_text(encoding="utf-8")
        assert "Sources to Audit Before Adoption" not in reference_text
        assert "Sources to audit before adoption" not in reference_text
        assert "https://" not in reference_text

    github_actions_text = (
        skills_root / "ci-security" / "references" / "github-actions.md"
    ).read_text(encoding="utf-8")
    assert "Sources to Audit Before Adoption" not in github_actions_text
    assert "Sources to audit before adoption" not in github_actions_text
    assert "https://" not in github_actions_text

    gitlab_ci_text = (
        skills_root / "ci-security" / "references" / "gitlab-ci.md"
    ).read_text(encoding="utf-8")
    assert "Sources to Audit Before Adoption" not in gitlab_ci_text
    assert "Sources to audit before adoption" not in gitlab_ci_text
    assert "https://" not in gitlab_ci_text

    for reference_path in (
        skills_root / "language-framework-security" / "references"
    ).glob("*.md"):
        reference_text = reference_path.read_text(encoding="utf-8")
        assert "Sources to Audit Before Adoption" not in reference_text
        assert "Sources to audit before adoption" not in reference_text
        assert "https://" not in reference_text

    with patch(
        "sec_review_agents.runtime.skills.tempfile.mkdtemp",
        side_effect=[
            str(tmp_path / "skills-base-root-2"),
            str(tmp_path / "skills-build-2"),
        ],
    ):
        skills_root = materialize_agent_skills_view(("scanner-finding-triage",))
    for reference_path in (skills_root / "scanner-finding-triage" / "references").glob(
        "*.md"
    ):
        reference_text = reference_path.read_text(encoding="utf-8")
        assert "Sources to Audit Before Adoption" not in reference_text
        assert "Sources to audit before adoption" not in reference_text
        assert "https://" not in reference_text
