import pytest
from pydantic import ValidationError

from sec_review_agents.agents.mitigation.model import MitigationOutput
from sec_review_agents.agents.patch_synthesis.model import PatchSynthesisOutput
from sec_review_agents.agents.single_agent.model import SingleAgentFixOutput


def test_mitigation_output_requires_only_overview() -> None:
    output = MitigationOutput.model_validate(
        {
            "overview": "No safe patch was produced.",
        }
    )
    assert output.overview == "No safe patch was produced."


def test_single_agent_output_requires_no_file_declaration() -> None:
    output = SingleAgentFixOutput.model_validate(
        {
            "overview": "No safe patch was produced.",
            "verdict": "no-actionable-finding",
            "validation_level": "static",
            "regression": "not-applicable",
            "target_claim": "",
            "residual_risks": [],
            "self_check_notes": ["No patch target."],
        }
    )
    assert output.overview == "No safe patch was produced."


def test_patch_synthesis_output_requires_overview() -> None:
    with pytest.raises(ValidationError):
        PatchSynthesisOutput.model_validate({})
    assert (
        PatchSynthesisOutput(overview="Combined repair committed.").overview
        == "Combined repair committed."
    )
