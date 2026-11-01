import pytest
from langgraph.runtime import Runtime

from sec_review_agents.agents.analysis.issue import build_issue_analyzer_backend_config
from sec_review_agents.runtime.runtime_config import (
    runtime_context_from_config,
    runtime_workspace_path,
)


def test_workspace_path_reaches_mount_and_working_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("EXECUTION_ALLOW_WORKSPACE_IMAGE_OVERRIDE", "true")
    monkeypatch.setenv("AGENT_SKILLS_ENABLED", "false")
    context = runtime_context_from_config({"workspace_path": "/workspace/project"})
    config = build_issue_analyzer_backend_config(
        workspace_root_path=tmp_path,
        history_path=tmp_path,
        runtime_context=context,
    )
    assert config.get("working_directory") == "/workspace/project"
    view = config["path_views"][0]
    assert view.host_path == tmp_path
    assert view.container_path == "/workspace/project"
    assert view.agent_path == "/workspace/project"
    assert runtime_workspace_path(None) == "/workspace"


@pytest.mark.parametrize(
    "value", ["/", "relative", "/a/../b", "/a/", "//a", " /a", 7, "/a,b"]
)
def test_reject_invalid_workspace_path(value, monkeypatch):
    monkeypatch.setenv("EXECUTION_ALLOW_WORKSPACE_IMAGE_OVERRIDE", "true")
    with pytest.raises(ValueError, match="workspace_path"):
        runtime_context_from_config({"workspace_path": value})


def test_workspace_path_requires_worker_opt_in(monkeypatch):
    monkeypatch.delenv("EXECUTION_ALLOW_WORKSPACE_IMAGE_OVERRIDE", raising=False)
    with pytest.raises(ValueError, match="disabled"):
        runtime_context_from_config({"workspace_path": "/workspace/project"})


def test_project_instructions_use_configured_workspace(tmp_path):
    from sec_review_agents.filesystem.backend_factory import (
        create_backend_with_path_views,
    )
    from sec_review_agents.filesystem.path_views import workspace_view
    from sec_review_agents.runtime.project_instructions_middleware import (
        ProjectInstructionsMiddleware,
    )

    content = "Project-specific instructions from the selected workspace."
    (tmp_path / "AGENTS.md").write_text(content)
    backend = create_backend_with_path_views(
        container_name_prefix="instructions-path",
        backend_kind="local",
        path_views=[
            workspace_view(host_path=tmp_path, agent_path="/workspace/project")
        ],
    )
    middleware = ProjectInstructionsMiddleware(
        backend=backend, workspace_root="/workspace/project"
    )
    result = middleware.before_agent({"messages": []}, Runtime())
    assert content in result["repository_instructions"]


def test_setup_uses_configured_workspace():
    from sec_review_agents.entrypoints.setup_declaration import parse_setup_declaration
    from sec_review_agents.runtime.setup_bootstrap import flatten_step_command

    declaration = parse_setup_declaration(
        "setup:\n  - run: pwd\n    working-directory: src\n"
    )
    assert (
        flatten_step_command(declaration.steps[0], workspace_root="/workspace/project")
        == "cd /workspace/project/src && pwd"
    )
