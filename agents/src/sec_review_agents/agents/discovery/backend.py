from sec_review_agents.agents.discovery.skills import DISCOVERY_AGENT_SKILLS
from sec_review_agents.features import agent_skills_enabled
from sec_review_agents.filesystem.backend_factory import (
    create_backend_with_materials,
)
from sec_review_agents.filesystem.material_views import (
    skill_view,
)
from sec_review_agents.runtime.skills import materialize_agent_skills_view


def create_repository_discovery_backend():
    material_views = []
    if agent_skills_enabled():
        material_views.append(
            skill_view(host_path=materialize_agent_skills_view(DISCOVERY_AGENT_SKILLS))
        )

    return create_backend_with_materials(
        container_name_prefix="repository-discovery",
        material_views=material_views,
        use_docker_sandbox=False,
    )
