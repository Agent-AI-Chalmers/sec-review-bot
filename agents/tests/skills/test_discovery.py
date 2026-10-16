import re

import pytest
from deepagents.middleware.skills import SkillsMiddleware

from sec_review_agents.agents.analysis.skills import ANALYSIS_AGENT_SKILLS
from sec_review_agents.agents.discovery.skills import DISCOVERY_AGENT_SKILLS
from sec_review_agents.agents.mitigation.skills import MITIGATION_AGENT_SKILLS
from sec_review_agents.agents.single_agent.skills import SINGLE_AGENT_SKILLS
from sec_review_agents.agents.triage.skills import TRIAGE_AGENT_SKILLS
from sec_review_agents.agents.verification.skills import VERIFICATION_AGENT_SKILLS
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.path_views import skill_view
from sec_review_agents.runtime.skills import materialize_agent_skills_view


@pytest.mark.parametrize(
    "declared",
    [
        ANALYSIS_AGENT_SKILLS,
        DISCOVERY_AGENT_SKILLS,
        MITIGATION_AGENT_SKILLS,
        SINGLE_AGENT_SKILLS,
        TRIAGE_AGENT_SKILLS,
        VERIFICATION_AGENT_SKILLS,
    ],
    ids=[
        "analysis",
        "discovery",
        "mitigation",
        "single-agent",
        "triage",
        "verification",
    ],
)
def test_declared_skills_are_discoverable_with_readable_local_references(
    declared: tuple[str, ...],
) -> None:
    """Literal /skills reference paths are a file contract, not a semantic router."""
    backend = create_backend_with_path_views(
        container_name_prefix="skill-discovery-test",
        path_views=[skill_view(host_path=materialize_agent_skills_view(declared))],
        backend_kind="local",
    )
    middleware = SkillsMiddleware(backend=backend, sources=["/skills/"])
    update = middleware.before_agent(
        {"messages": []},
        None,  # type: ignore[arg-type]  # Metadata loading does not use the runtime.
        {},
    )
    assert update is not None
    metadata = update.get("skills_metadata") or []
    assert {skill["name"] for skill in metadata} == set(declared)
    for skill in metadata:
        name = skill["name"]
        assert skill["path"] == f"/skills/{name}/SKILL.md"
        assert skill["description"].strip()
        entry = backend.read(skill["path"])
        assert entry.error is None
        assert entry.file_data is not None
        # Only the literal file targets are inspected; no security guidance
        # or model behavior is inferred from prose or keyword presence.
        text = entry.file_data["content"]
        assert isinstance(text, str)
        references = set(re.findall(r"`(/skills/[^`]+\.md)`", text))
        assert references
        for reference in references:
            assert reference.startswith(f"/skills/{name}/")
            resource = backend.read(reference)
            assert resource.error is None, (reference, resource.error)
            assert resource.file_data is not None
            assert resource.file_data["content"]
