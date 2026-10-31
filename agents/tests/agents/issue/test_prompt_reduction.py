from sec_review_agents.agents.mitigation.issue import (
    build_issue_mitigation_user_prompt,
    build_issue_self_check_mitigation_user_prompt,
)
from sec_review_agents.agents.verification.issue import (
    build_issue_verification_user_prompt,
)
from sec_review_agents.agents.verification.pull_request import (
    build_pr_verification_user_prompt,
)
from sec_review_agents.review_stages.feedback_loop import (
    feedback_retry_context,
    verification_feedback_retry_context,
)
from sec_review_agents.review_stages.mitigation.result import MitigationStageResult
from sec_review_agents.review_stages.verification.result import VerificationStageResult
from tests.analysis_fixtures import analysis_fixture, narrative_fixture

WORKSPACE_PATCH = "diff --git a/a.py b/a.py"


def test_repair_prompt_uses_all_analysis_narratives_as_context() -> None:
    """Retain unconfirmed narratives so mitigation sees the complete analysis."""
    prompt = build_issue_mitigation_user_prompt(
        issue={"title": "Issue title", "body": "Issue body"},
        retry_context=None,
        analysis_result=analysis_fixture(
            overview="Analyzer overview",
            verdict="plausible-risk",
            narratives=[
                narrative_fixture(
                    verdict="no-actionable-finding",
                    title="Unconfirmed issue narrative",
                    priority=1,
                )
            ],
        ),
    )

    assert "Unconfirmed issue narrative" in prompt


def test_self_check_prompt_uses_repair_narratives_context() -> None:
    """Give the self-check pass the same candidate narrative it must reassess."""
    prompt = build_issue_self_check_mitigation_user_prompt(
        issue={
            "title": "Issue title",
            "body": "Issue body",
        },
        analysis_result=analysis_fixture(
            overview="Analyzer overview",
            verdict="plausible-risk",
            narratives=[
                narrative_fixture(
                    verdict="no-actionable-finding",
                    title="Unconfirmed target",
                    priority=1,
                )
            ],
        ),
    )

    assert "Unconfirmed target" in prompt


def test_initial_verification_prompt_omits_narratives_section() -> None:
    """Keep verification focused on rendered analysis and mitigation evidence."""
    input_data = {
        "issue": {
            "title": "SSRF issue",
            "body": "Remote URL fetch may be unsafe.",
        }
    }
    analysis_result = analysis_fixture(
        overview="Analyzer overview",
        verdict="confirmed-vulnerability",
        narratives=[
            narrative_fixture(
                verdict="confirmed-vulnerability", title="Should not appear"
            )
        ],
    )
    mitigation_result = MitigationStageResult(
        overview="Mitigation overview",
        file_changes=[{"path": "a.py", "status": "deleted"}],
    )

    prompt = build_issue_verification_user_prompt(
        issue=input_data["issue"],
        retry_context=None,
        analysis_result=analysis_result,
        mitigation_result=mitigation_result,
        workspace_patch=WORKSPACE_PATCH,
    )

    assert "Analysis Summary" in prompt
    assert "Mitigation Summary" in prompt
    mitigation_section = prompt.split("# Mitigation Summary", 1)[1].split(
        "# Workspace Patch", 1
    )[0]
    assert "```json" not in mitigation_section
    assert "Mitigation overview" in mitigation_section
    assert "- a.py" in mitigation_section
    assert "Analyzer-Reported Narratives" not in prompt
    assert "Narrative Count" not in prompt
    assert "Should not appear" not in prompt


def test_retry_verifier_feedback_keeps_only_lightweight_fields() -> None:
    """Pass corrective verifier fields forward without replaying the full result."""
    input_data = {
        "retry_context": feedback_retry_context(
            retry_index=1,
            mitigation_result=None,
            verifier_result=VerificationStageResult(
                overview="Previous verifier found a gap.",
                review_target_claim="claim",
                patch_coverage="partial",
                resolution_next_step="retry-ai",
                patch_findings=["concern"],
                validation_level="static",
                verification_findings=["verbose note"],
                regression_status=None,
            ),
            history=[
                *feedback_retry_context(
                    retry_index=1,
                    mitigation_result=None,
                    verifier_result=VerificationStageResult(
                        patch_coverage="partial",
                        resolution_next_step="retry-ai",
                        patch_findings=["gap"],
                        verification_findings=["verbose note"],
                        overview="Test verification",
                        review_target_claim=None,
                        validation_level=None,
                        regression_status=None,
                    ),
                ).history
            ],
        )
    }

    payload = verification_feedback_retry_context(input_data.get("retry_context"))
    assert payload is not None
    latest = payload.latest_verifier
    assert latest is not None

    assert latest.review_target_claim == "claim"
    assert latest.resolution_next_step == "retry-ai"
    assert latest.patch_findings == ["concern"]
    assert latest.verification_findings == ["verbose note"]


def test_retry_issue_verification_prompt_inlines_original_issue_text() -> None:
    """Keep retry verification anchored to the original issue and ordered fields."""
    prompt = build_issue_verification_user_prompt(
        issue={
            "title": "Original issue title",
            "body": "Original issue body",
        },
        retry_context=feedback_retry_context(
            retry_index=1,
            mitigation_result=None,
            verifier_result=VerificationStageResult(
                review_target_claim="claim",
                patch_coverage="partial",
                resolution_next_step="retry-ai",
                patch_findings=["gap"],
                overview="Test verification",
                validation_level=None,
                regression_status=None,
            ),
        ),
        analysis_result=analysis_fixture(
            overview="analysis", verdict=None, narratives=[]
        ),
        mitigation_result=MitigationStageResult(overview="new mitigation"),
        workspace_patch=WORKSPACE_PATCH,
    )

    assert "# Issue Text" in prompt
    assert "Original issue title" in prompt
    assert "Original issue body" in prompt
    mitigation_section = prompt.split("# New Mitigation Summary", 1)[1].split(
        "# Workspace Patch", 1
    )[0]
    assert "```json" not in mitigation_section
    assert "new mitigation" in mitigation_section
    assert "Previous Verifier Result" in prompt
    previous_verifier_section = prompt.split("# Previous Verifier Result", 1)[1]
    assert "```json" not in previous_verifier_section
    assert previous_verifier_section.index("- Review target claim: claim") < (
        previous_verifier_section.index("- Patch coverage: `partial`")
    )
    assert previous_verifier_section.index("- Patch coverage: `partial`") < (
        previous_verifier_section.index("- Resolution next step: `retry-ai`")
    )
    assert "- Patch coverage: `partial`" in prompt
    assert "Patch findings:" in prompt
    assert "- gap" in prompt


def test_retry_issue_verification_prompt_renders_history_without_json_block() -> None:
    """Render retry history as readable evidence rather than opaque JSON."""
    prompt = build_issue_verification_user_prompt(
        issue={
            "title": "Original issue title",
            "body": "Original issue body",
        },
        retry_context=feedback_retry_context(
            retry_index=2,
            mitigation_result=None,
            verifier_result=None,
            history=[
                *feedback_retry_context(
                    retry_index=1,
                    mitigation_result=None,
                    verifier_result=VerificationStageResult(
                        patch_coverage="partial",
                        patch_findings=["still misses retry path"],
                        overview="Test verification",
                        review_target_claim=None,
                        resolution_next_step="none",
                        validation_level=None,
                        regression_status=None,
                    ),
                ).history
            ],
        ),
        analysis_result=analysis_fixture(
            overview="analysis", verdict=None, narratives=[]
        ),
        mitigation_result=MitigationStageResult(overview="new mitigation"),
        workspace_patch=WORKSPACE_PATCH,
    )

    history_section = prompt.split("# Retry History Projection", 1)[1]
    assert "```json" not in history_section
    assert "- Retry 1" in history_section
    assert "- Retry index: `1`" in history_section
    assert "- Patch coverage: `partial`" in history_section
    assert "- still misses retry path" in history_section


def test_retry_pr_verification_prompt_inlines_original_pr_text() -> None:
    """Keep pull-request retries grounded in the original proposal text."""
    prompt = build_pr_verification_user_prompt(
        pr={
            "title": "Original PR title",
            "body": "Original PR body",
            "base_ref": "main",
            "base_sha": "base",
            "head_ref": "branch",
            "head_sha": "head",
            "commit_shas": ["head"],
        },
        retry_context=feedback_retry_context(
            retry_index=1,
            mitigation_result=None,
            verifier_result=VerificationStageResult(
                review_target_claim="claim",
                patch_coverage="partial",
                resolution_next_step="retry-ai",
                patch_findings=["gap"],
                overview="Test verification",
                validation_level=None,
                regression_status=None,
            ),
        ),
        analysis_result=analysis_fixture(
            overview="analysis", verdict=None, narratives=[]
        ),
        mitigation_result=MitigationStageResult(overview="new mitigation"),
        workspace_patch=WORKSPACE_PATCH,
    )

    assert "# Pull Request Text" in prompt
    assert "Original PR title" in prompt
    assert "Original PR body" in prompt
    assert "Previous Verifier Result" in prompt


def test_initial_pr_verification_prompt_omits_narratives_section() -> None:
    """Avoid duplicating analyzer narratives when verifier summaries are sufficient."""
    prompt = build_pr_verification_user_prompt(
        pr={
            "title": "Original PR title",
            "body": "Original PR body",
            "base_ref": "main",
            "base_sha": "base",
            "head_ref": "branch",
            "head_sha": "head",
            "commit_shas": ["head"],
        },
        retry_context=None,
        analysis_result=analysis_fixture(
            overview="Analyzer overview",
            verdict="confirmed-vulnerability",
            narratives=[
                narrative_fixture(
                    verdict="confirmed-vulnerability", title="Should not appear"
                )
            ],
        ),
        mitigation_result=MitigationStageResult(overview="new mitigation"),
        workspace_patch=WORKSPACE_PATCH,
    )

    assert "Analysis Summary" in prompt
    assert "Mitigation Summary" in prompt
    assert "Analyzer-Reported Narratives" not in prompt
    assert "Narrative Count" not in prompt
    assert "Should not appear" not in prompt


def test_retry_mitigation_prompt_keeps_verifier_as_primary_corrective_signal() -> None:
    """Make verifier findings the actionable retry signal while retaining context."""
    input_data = {
        "issue": {
            "title": "Issue title",
            "body": "Issue body",
        }
    }
    analysis_result = analysis_fixture(
        overview="Analyzer overview", verdict="confirmed-vulnerability", narratives=[]
    )
    retry_context = feedback_retry_context(
        retry_index=1,
        mitigation_result=MitigationStageResult(
            overview="Old mitigation",
            file_changes=[{"path": path, "status": "deleted"} for path in ["a.py"]],
        ),
        verifier_result=VerificationStageResult(
            overview="Old verifier",
            review_target_claim="claim",
            patch_coverage="partial",
            resolution_next_step="retry-ai",
            validation_level="static",
            patch_findings=["gap"],
            verification_findings=["note"],
            regression_status=None,
        ),
        history=[
            *feedback_retry_context(
                retry_index=1,
                mitigation_result=None,
                verifier_result=VerificationStageResult(
                    patch_coverage="partial",
                    resolution_next_step="retry-ai",
                    patch_findings=["old gap"],
                    overview="Test verification",
                    review_target_claim=None,
                    validation_level=None,
                    regression_status=None,
                ),
            ).history
        ],
    )

    prompt = build_issue_mitigation_user_prompt(
        issue=input_data["issue"],
        retry_context=retry_context,
        analysis_result=analysis_result,
    )

    assert "Retry Revision Context" in prompt
    retry_section = prompt.split("# Retry Revision Context", 1)[1].split(
        "# Analyzer Context", 1
    )[0]
    assert "```json" not in retry_section
    assert "Latest verifier:" in retry_section
    assert retry_section.index("- Review target claim: claim") < (
        retry_section.index("- Patch coverage: `partial`")
    )
    assert retry_section.index("- Patch coverage: `partial`") < (
        retry_section.index("- Resolution next step: `retry-ai`")
    )
    assert "- Validation level: `static`" in retry_section
    assert "- Patch findings:" in retry_section
    assert "- gap" in prompt
    assert "Previous mitigation:" in retry_section
    assert "- a.py" in retry_section
    assert "Verifier history snapshot:" in retry_section
    assert "- Retry 1" in retry_section
    assert "- Retry index: `1`" in retry_section
    assert "- old gap" in retry_section
