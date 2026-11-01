from sec_review_agents.agents.analysis.issue import (
    build_issue_analyzer_filesystem_system_prompt,
)
from sec_review_agents.resources import loader


def test_workspace_template_preserves_literal_paths_and_code(tmp_path, monkeypatch):
    monkeypatch.setattr(loader, "AGENT_PROMPTS", tmp_path)
    (tmp_path / "section.md").write_text(
        '{{workspace_root}}\n/workspace/example\n{"key": "value"}\n${HOME}\n'
    )
    assert (
        loader.join_prompt_sections(
            ["section.md"], workspace_root="/workspace/RestrictedPython"
        )
        == '/workspace/RestrictedPython\n/workspace/example\n{"key": "value"}\n${HOME}'
    )
    assert loader.load_prompt_resource("section.md").splitlines()[0] == "/workspace"


def test_prompt_builder_renders_selected_resources(monkeypatch):
    monkeypatch.setenv("AGENT_JOERN_ENABLED", "false")
    monkeypatch.setenv("AGENT_PLAYWRIGHT_ENABLED", "false")
    root = "/workspace/RestrictedPython"
    assert build_issue_analyzer_filesystem_system_prompt(
        workspace_root=root
    ) == loader.join_prompt_sections(
        [
            "analyzer/filesystem-system-core.md",
            "scopes/issue/analyzer/filesystem-system-delta.md",
        ],
        workspace_root=root,
    )
