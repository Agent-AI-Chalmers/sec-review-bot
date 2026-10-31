from sec_review_agents.review_stages import feedback_loop


def test_retry_decision_follows_verifier_next_step_without_requiring_a_patch() -> None:
    """A failed first mitigation can receive a bounded retry before any patch exists."""
    assert feedback_loop.should_retry_from_verifier_result(
        {"resolution_next_step": "retry-ai"},
    )
    assert not feedback_loop.should_retry_from_verifier_result(
        {"resolution_next_step": "none"},
    )
    assert not feedback_loop.should_retry_from_verifier_result(
        None,
    )


def test_feedback_retry_context_projects_previous_verifier_feedback() -> None:
    """Carry actionable verifier fields into retry context without raw artifacts."""
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
            "regression_status": "failed",
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
        "regression_status": "failed",
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
            "regression_status": "failed",
            "verification_findings": [],
            "residual_risks": [],
        }
    ]


def test_feedback_retry_context_accumulates_previous_verifier_history() -> None:
    """Retain regression state across bounded verifier retry history."""
    first_retry_context = feedback_loop.feedback_retry_context(
        retry_index=1,
        mitigation_result={"overview": "first patch", "changed_files": ["app.py"]},
        verifier_result={
            "overview": "first verifier",
            "patch_coverage": "partial",
            "resolution_next_step": "retry-ai",
            "regression_status": "not-run",
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
            "regression_status": "passed",
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
            "regression_status": "not-run",
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
            "regression_status": "passed",
            "verification_findings": [],
            "residual_risks": [],
        },
    ]
    assert second_retry_context["previous_verifier_result"]["overview"] == (
        "second verifier"
    )


def test_retry_prompt_retains_changed_paths_after_summary_projection() -> None:
    """A compact summary must not be interpreted again as a raw stage result."""
    context = feedback_loop.feedback_retry_context(
        retry_index=1,
        mitigation_result={
            "overview": "Added a guard",
            "file_changes": [
                {"path": "src/guard.py", "status": "upsert", "content": "secret body"}
            ],
            "patch_diff": "private raw patch",
        },
        verifier_result={"overview": "Guard needs revision"},
    )
    projected = feedback_loop.mitigation_feedback_retry_context(context)
    assert projected is not None
    assert projected["previous_mitigation"] == {
        "overview": "Added a guard",
        "changed_files": ["src/guard.py"],
    }
    rendered = feedback_loop.render_retry_revision_context_section(projected)
    assert rendered is not None
    assert "src/guard.py" in rendered
    assert "secret body" not in rendered
    assert "private raw patch" not in rendered
