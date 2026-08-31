import pytest
from pydantic import ValidationError

from sec_review_agents.agents.mitigation.model import MitigationOutput
from sec_review_agents.agents.patch_synthesis.model import PatchSynthesisOutput
from sec_review_agents.agents.single_agent.model import SingleAgentFixOutput


def test_mitigation_output_allows_empty_declared_files() -> None:
    output = MitigationOutput.model_validate(
        {
            "overview": "No safe patch was produced.",
            "declared_changed_files": [],
        }
    )
    assert output.declared_changed_files == []


def test_single_agent_output_allows_empty_declared_files() -> None:
    output = SingleAgentFixOutput.model_validate(
        {
            "overview": "No safe patch was produced.",
            "verdict": "no-actionable-finding",
            "validation_level": "static",
            "regression_status": "not-applicable",
            "target_claim": "",
            "declared_changed_files": [],
            "residual_risks": [],
            "self_check_notes": ["No patch target."],
        }
    )
    assert output.declared_changed_files == []


def test_patch_synthesis_output_requires_declared_files() -> None:
    with pytest.raises(ValidationError, match="declared_changed_files"):
        PatchSynthesisOutput.model_validate({"declared_changed_files": []})


def test_declared_changed_files_reuse_workspace_path_normalization() -> None:
    output = MitigationOutput.model_validate(
        {
            "overview": "Updated one file.",
            "declared_changed_files": ["a/src/app.py", "src/app.py"],
        }
    )
    assert output.declared_changed_files == ["src/app.py"]


def test_declared_changed_files_reject_workspace_root() -> None:
    with pytest.raises(ValidationError, match="must name repository files"):
        MitigationOutput.model_validate(
            {
                "overview": "Updated one file.",
                "declared_changed_files": ["/workspace"],
            }
        )

    with pytest.raises(ValidationError, match="must name repository files"):
        MitigationOutput.model_validate(
            {
                "overview": "Updated one file.",
                "declared_changed_files": ["workspace"],
            }
        )
