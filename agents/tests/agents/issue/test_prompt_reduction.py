from sec_review_agents.agents.mitigation.issue import (
    build_issue_mitigation_user_prompt,
    build_issue_self_check_mitigation_system_prompt,
    build_issue_self_check_mitigation_user_prompt,
)
from sec_review_agents.agents.verification.issue import (
    build_issue_verification_user_prompt,
)
from sec_review_agents.agents.verification.pull_request import (
    build_pr_verification_user_prompt,
)
from sec_review_agents.review_stages.feedback_loop import (
    verification_feedback_retry_context,
)

WORKSPACE_PATCH = "diff --git a/a.py b/a.py"


def test_repair_prompt_uses_all_analysis_narratives_as_context() -> None:
    prompt = build_issue_mitigation_user_prompt(
        issue={"title": "Issue title", "body": "Issue body"},
        retry_context=None,
        analysis_result={
            "overview": "Analyzer overview",
            "verdict": "plausible-risk",
            "narratives": [
                {
                    "priority": 1,
                    "title": "Unconfirmed issue narrative",
                    "verdict": "no-actionable-finding",
                },
                "not-a-narrative",
            ],
        },
    )

    assert "Unconfirmed issue narrative" in prompt
    assert "not-a-narrative" in prompt


def test_self_check_prompt_uses_repair_narratives_context() -> None:
    prompt = build_issue_self_check_mitigation_user_prompt(
        issue={
            "title": "Issue title",
            "body": "Issue body",
        },
        analysis_result={
            "overview": "Analyzer overview",
            "verdict": "plausible-risk",
            "narratives": [
                {
                    "priority": 1,
                    "title": "Unconfirmed target",
                    "verdict": "no-actionable-finding",
                }
            ],
        },
    )

    assert "Unconfirmed target" in prompt


def test_self_check_system_prompt_uses_repair_mode_boundary() -> None:
    prompt = build_issue_self_check_mitigation_system_prompt(
        repair_mode="no-test-changes"
    )

    assert "# No-Test-Changes Boundary" in prompt
    assert "# Test-Changes-Allowed Boundary" not in prompt
    assert "# Git History Remediation Boundary" in prompt


def test_initial_verification_prompt_omits_narratives_section() -> None:
    input_data = {
        "issue": {
            "title": "SSRF issue",
            "body": "Remote URL fetch may be unsafe.",
        }
    }
    analysis_result = {
        "overview": "Analyzer overview",
        "verdict": "confirmed-vulnerability",
        "narratives": [
            {
                "title": "Should not appear",
                "verdict": "confirmed-vulnerability",
            }
        ],
    }
    mitigation_result = {
        "overview": "Mitigation overview",
        "changed_files": ["a.py"],
        "residual_risks": ["risk-b"],
    }

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
    input_data = {
        "retry_context": {
            "retry_index": 1,
            "history": [
                {
                    "retry_index": 0,
                    "patch_coverage": "partial",
                    "resolution_next_step": "retry-ai",
                    "patch_findings": ["gap"],
                    "verification_findings": ["verbose note"],
                }
            ],
            "previous_verifier_result": {
                "overview": "Previous verifier found a gap.",
                "review_target_claim": "claim",
                "patch_coverage": "partial",
                "resolution_next_step": "retry-ai",
                "patch_findings": ["concern"],
                "validation_level": "static",
                "verification_findings": ["verbose note"],
            },
        }
    }

    payload = verification_feedback_retry_context(input_data.get("retry_context"))
    assert payload is not None
    latest = payload["latest_verifier"]

    assert latest["review_target_claim"] == "claim"
    assert latest["resolution_next_step"] == "retry-ai"
    assert latest["patch_findings"] == ["concern"]
    assert latest["verification_findings"] == ["verbose note"]


def test_retry_issue_verification_prompt_inlines_original_issue_text() -> None:
    prompt = build_issue_verification_user_prompt(
        issue={
            "title": "Original issue title",
            "body": "Original issue body",
        },
        retry_context={
            "retry_index": 1,
            "previous_verifier_result": {
                "review_target_claim": "claim",
                "patch_coverage": "partial",
                "resolution_next_step": "retry-ai",
                "patch_findings": ["gap"],
            },
        },
        analysis_result={"overview": "analysis"},
        mitigation_result={"overview": "new mitigation"},
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
    assert previous_verifier_section.index("- Review target claim: `claim`") < (
        previous_verifier_section.index("- Patch coverage: `partial`")
    )
    assert previous_verifier_section.index("- Patch coverage: `partial`") < (
        previous_verifier_section.index("- Resolution next step: `retry-ai`")
    )
    assert "- Patch coverage: `partial`" in prompt
    assert "Patch findings:" in prompt
    assert "- gap" in prompt


def test_retry_issue_verification_prompt_renders_history_without_json_block() -> None:
    prompt = build_issue_verification_user_prompt(
        issue={
            "title": "Original issue title",
            "body": "Original issue body",
        },
        retry_context={
            "retry_index": 2,
            "history": [
                {
                    "retry_index": 1,
                    "patch_coverage": "partial",
                    "patch_findings": ["still misses retry path"],
                }
            ],
        },
        analysis_result={"overview": "analysis"},
        mitigation_result={"overview": "new mitigation"},
        workspace_patch=WORKSPACE_PATCH,
    )

    history_section = prompt.split("# Retry History Projection", 1)[1]
    assert "```json" not in history_section
    assert "- Retry 1" in history_section
    assert "- Retry index: `1`" in history_section
    assert "- Patch coverage: `partial`" in history_section
    assert "- still misses retry path" in history_section


def test_retry_pr_verification_prompt_inlines_original_pr_text() -> None:
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
        retry_context={
            "retry_index": 1,
            "previous_verifier_result": {
                "review_target_claim": "claim",
                "patch_coverage": "partial",
                "resolution_next_step": "retry-ai",
                "patch_findings": ["gap"],
            },
        },
        analysis_result={"overview": "analysis"},
        mitigation_result={"overview": "new mitigation"},
        workspace_patch=WORKSPACE_PATCH,
        diff_metadata={"files": []},
    )

    assert "# Pull Request Text" in prompt
    assert "Original PR title" in prompt
    assert "Original PR body" in prompt
    assert "Previous Verifier Result" in prompt


def test_initial_pr_verification_prompt_omits_narratives_section() -> None:
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
        analysis_result={
            "overview": "Analyzer overview",
            "verdict": "confirmed-vulnerability",
            "narratives": [
                {
                    "title": "Should not appear",
                    "verdict": "confirmed-vulnerability",
                }
            ],
        },
        mitigation_result={"overview": "new mitigation"},
        workspace_patch=WORKSPACE_PATCH,
        diff_metadata={"files": []},
    )

    assert "Analysis Summary" in prompt
    assert "Mitigation Summary" in prompt
    assert "Analyzer-Reported Narratives" not in prompt
    assert "Narrative Count" not in prompt
    assert "Should not appear" not in prompt


def test_retry_mitigation_prompt_keeps_verifier_as_primary_corrective_signal() -> None:
    input_data = {
        "issue": {
            "title": "Issue title",
            "body": "Issue body",
        }
    }
    analysis_result = {
        "overview": "Analyzer overview",
        "verdict": "confirmed-vulnerability",
        "narratives": [],
    }
    retry_context = {
        "retry_index": 1,
        "previous_mitigation_result": {
            "overview": "Old mitigation",
            "changed_files": ["a.py"],
        },
        "previous_verifier_result": {
            "overview": "Old verifier",
            "review_target_claim": "claim",
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "validation_level": "static",
            "patch_findings": ["gap"],
            "verification_findings": ["note"],
        },
        "history": [
            {
                "retry_index": 1,
                "patch_coverage": "partial",
                "resolution_next_step": "retry-ai",
                "patch_findings": ["old gap"],
            }
        ],
    }

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
    assert retry_section.index("- Review target claim: `claim`") < (
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
