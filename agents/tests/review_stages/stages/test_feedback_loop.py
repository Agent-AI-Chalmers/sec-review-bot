from sec_review_agents.review_stages import feedback_loop


def test_retry_decision_requires_changed_files_and_retry_ai_verifier_next_step() -> (
    None
):
    assert feedback_loop.should_retry_from_verifier_result(
        {"changed_files": ["app.py"]},
        {"resolution_next_step": "retry-ai"},
    )
    assert not feedback_loop.should_retry_from_verifier_result(
        {"changed_files": []},
        {"resolution_next_step": "retry-ai"},
    )
    assert not feedback_loop.should_retry_from_verifier_result(
        {"changed_files": ["app.py"]},
        {"resolution_next_step": "none"},
    )


def test_feedback_retry_context_projects_previous_verifier_feedback() -> None:
    retry_context = feedback_loop.feedback_retry_context(
        retry_index=1,
        mitigation_result={
            "overview": "patched",
            "changed_files": ["app.py"],
            "patch_diff": "large diff must not enter retry context",
            "file_changes": [{"path": "app.py"}],
        },
        verifier_result={
            "overview": "needs revision",
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["missing guard"],
            "raw_trace": "large verifier detail must not enter retry context",
        },
    )

    assert retry_context["retry_index"] == 1
    assert retry_context["previous_mitigation_result"] == {
        "overview": "patched",
        "changed_files": ["app.py"],
    }
    assert retry_context["previous_verifier_result"] == {
        "overview": "needs revision",
        "review_target_claim": None,
        "patch_coverage": "partial",
        "resolution_next_step": "retry-ai",
        "patch_findings": ["missing guard"],
        "validation_level": None,
        "verification_findings": [],
        "residual_risks": [],
    }
    assert "patch_diff" not in retry_context["previous_mitigation_result"]
    assert "file_changes" not in retry_context["previous_mitigation_result"]
    assert "raw_trace" not in retry_context["previous_verifier_result"]
    assert retry_context["history"] == [
        {
            "retry_index": 1,
            "overview": "needs revision",
            "review_target_claim": None,
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["missing guard"],
            "validation_level": None,
            "verification_findings": [],
            "residual_risks": [],
        }
    ]


def test_feedback_retry_context_accumulates_previous_verifier_history() -> None:
    first_retry_context = feedback_loop.feedback_retry_context(
        retry_index=1,
        mitigation_result={"overview": "first patch", "changed_files": ["app.py"]},
        verifier_result={
            "overview": "first verifier",
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["first gap"],
        },
    )

    second_retry_context = feedback_loop.feedback_retry_context(
        retry_index=2,
        mitigation_result={"overview": "second patch", "changed_files": ["app.py"]},
        verifier_result={
            "overview": "second verifier",
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["second gap"],
        },
        history=first_retry_context["history"],
    )

    assert second_retry_context["history"] == [
        {
            "retry_index": 1,
            "overview": "first verifier",
            "review_target_claim": None,
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["first gap"],
            "validation_level": None,
            "verification_findings": [],
            "residual_risks": [],
        },
        {
            "retry_index": 2,
            "overview": "second verifier",
            "review_target_claim": None,
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "patch_findings": ["second gap"],
            "validation_level": None,
            "verification_findings": [],
            "residual_risks": [],
        },
    ]
    assert second_retry_context["previous_verifier_result"]["overview"] == (
        "second verifier"
    )
