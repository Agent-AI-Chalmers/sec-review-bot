"""Filesystem backend construction for memory observation extraction."""

from deepagents.backends.protocol import BackendProtocol

from sec_review_agents.features import agent_skills_enabled
from sec_review_agents.filesystem.backend_factory import create_backend_with_path_views
from sec_review_agents.filesystem.path_views import skill_view
from sec_review_agents.runtime.skills import materialize_all_agent_skills_view


def create_memory_extractor_backend() -> BackendProtocol:
    """Mount skills only; staged trajectories are accessible through structured tools.

    Skills are existing agent knowledge for the extraction decision, not source
    evidence. Mounting every packaged skill lets the extractor reject trajectory
    lessons that merely restate guidance already available to review agents.
    """
    # Unmatched paths use the factory's StateBackend: /tmp scratch files live
    # in this invocation's graph state, never in the host temporary directory.
    path_views = []
    if agent_skills_enabled():
        # SkillsMiddleware reads from /skills, so the backend mount and middleware
        # gate must follow the same feature flag.
        path_views.append(skill_view(host_path=materialize_all_agent_skills_view()))
    return create_backend_with_path_views(
        container_name_prefix="memory-extractor",
        path_views=path_views,
        backend_kind="local",
    )


__all__ = ["create_memory_extractor_backend"]
