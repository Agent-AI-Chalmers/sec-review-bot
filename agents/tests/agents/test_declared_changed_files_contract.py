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


def test_declared_changed_files_preserve_repository_prefix() -> None:
    # A declared path may be a real top-level a/ or b/ directory. It must not be
    # collapsed with the git diff-prefix strip, or the declared path would stop
    # matching the observed changed file and the stage would fail.
    output = MitigationOutput.model_validate(
        {
            "overview": "Updated one file.",
            "declared_changed_files": ["a/src/app.py", "src/app.py"],
        }
    )
    assert output.declared_changed_files == ["a/src/app.py", "src/app.py"]


@pytest.mark.parametrize(
    ("declared_files", "error_type"),
    [
        ("a.txt", "list_type"),
        ({"path": "a.txt"}, "list_type"),
        (None, "list_type"),
        (["/workspace"], "value_error"),
        (["workspace"], "value_error"),
        (["../escape.txt"], "value_error"),
        ([".git/config"], "value_error"),
    ],
)
@pytest.mark.parametrize(
    "output_type", [MitigationOutput, SingleAgentFixOutput, PatchSynthesisOutput]
)
def test_output_rejects_invalid_declared_files(
    output_type: type[MitigationOutput | SingleAgentFixOutput | PatchSynthesisOutput],
    declared_files: object,
    error_type: str,
) -> None:
    """Malformed declarations fail at structured output parsing, before acceptance."""
    with pytest.raises(ValidationError) as error:
        output_type.model_validate(
            {
                "overview": "Updated one file.",
                "verdict": "no-actionable-finding",
                "validation_level": "static",
                "regression_status": "not-applicable",
                "target_claim": "",
                "self_check_notes": ["No patch target."],
                "declared_changed_files": declared_files,
            }
        )
    assert any(item["type"] == error_type for item in error.value.errors())
